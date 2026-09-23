#!/usr/bin/env node
/**
 * F8 分享卡片：构建期生成 1200×630 的 OG 预览图。
 *
 * 路径（见 docs/tech-selection.md 五）：复用 src/lib/scene.js 的图元画生存曲线缩略，
 * 叠上核心数字，出 SVG 后交给 @resvg/resvg-js 转 PNG，落到 dist/og-image.png。
 *
 * ⚠ 一个必须先说清的坑：**Ubuntu / Debian 默认不装 CJK 字体**。
 *   没有中文字体时 resvg 不会报错，它只是把每个汉字画成一个空方框 ——
 *   静默产出一张坏卡片。所以这里做一道前置探测：找不到中文字体就
 *   直接放弃出图并大声提示，而不是产出一张一半是方框的图。
 *   CI 侧的对策见 .github/workflows/collect.yml 的「安装中文字体」步骤。
 *
 * 用法：
 *   构建时由 scripts/build.mjs 调用（走导出的 buildOgImage）
 *   单独调试：node scripts/og-image.mjs   →  写 dist/og-image.png
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';

import { buildChartData, fmtDateIn, fmtDateTimeIn } from '../src/lib/chart-data.js';
import { predictAll } from '../src/lib/predict.mjs';
import { PALETTE, estimateTextWidth, survivalScene } from '../src/lib/scene.js';
import { verdictOf } from '../src/lib/render.mjs';
import { renderSceneSvg } from '../src/lib/svg.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CJK = 'Asia/Shanghai';
const DAY = 86_400_000;

export const OG_W = 1200;
export const OG_H = 630;

/* ------------------------------ 字体 ------------------------------ */

// 与页面同一套字体栈，末尾追加 Linux 下 fonts-noto-cjk 提供的族名
const SANS =
  '-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans SC","Noto Sans CJK SC","Source Han Sans SC","Microsoft YaHei",sans-serif';
const MONO = 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace';

// 只认「确定带汉字」的字体名，避免把 DejaVu 之类纯拉丁字体当救命稻草
const CJK_FONT_NAME =
  /(pingfang|hiragino|stheiti|heiti|songti|noto[-_]?sans[-_]?cjk|notosanscjk|noto[-_]?serif[-_]?cjk|source[-_]?han|wqy|droid[-_]?sans[-_]?fallback|msyh|simhei|simsun|fangsong|kai)/i;

const FONT_DIRS = [
  '/System/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
  '/Library/Fonts',
  join(homedir(), 'Library/Fonts'),
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  join(homedir(), '.fonts'),
  join(homedir(), '.local/share/fonts'),
  'C:/Windows/Fonts',
];

function scanFontDir(dir, depth) {
  if (depth > 3) return null;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null; // 目录不存在或无权限，跳过
  }
  for (const name of names) {
    if (CJK_FONT_NAME.test(name)) return join(dir, name);
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) {
        const hit = scanFontDir(full, depth + 1);
        if (hit) return hit;
      }
    } catch {
      /* 单个条目读不了不影响整体探测 */
    }
  }
  return null;
}

/** @returns {string|null} 找到的中文字体路径；找不到返回 null */
export function detectCjkFont(dirs = FONT_DIRS) {
  for (const dir of dirs) {
    const hit = scanFontDir(dir, 0);
    if (hit) return hit;
  }
  return null;
}

/* ---------------------------- 品牌标 ---------------------------- */

/**
 * 卡片左上角的品牌标，以 data URI 嵌入 SVG。
 *
 * 源图是**不透明黑底**的方形图，这里不抠底 —— 图形本体是白色描边，
 * 抠掉黑底会把描边一起抹掉。改成给一个圆角剪裁（clipPath），
 * 于是「黑方块」在宣纸白卡片上读起来是「App 图标」。
 *
 * 同步读：buildOgSvg 是同步函数，不能在里面 await。文件在版本控制里，
 * 读不到说明仓库不完整 —— 直接抛，不静默出一张没有品牌标的卡片。
 */
const LOGO_SRC = 'src/assets/logo-168.png';
let _logoHref = null;

function logoHref() {
  if (_logoHref === null) {
    const buf = readFileSync(resolve(ROOT, LOGO_SRC));
    _logoHref = `data:image/png;base64,${buf.toString('base64')}`;
  }
  return _logoHref;
}

/* ------------------------------ 数字 ------------------------------ */

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 卡片上出现的全部数字，同时用于 og:description —— 图与文字不能各算各的 */
export function ogNumbers(model, prediction) {
  const p = prediction?.prediction;
  const elapsed = (model.now - new Date(model.lastAt).getTime()) / DAY;
  return {
    elapsed: elapsed.toFixed(1),
    remaining: p ? p.q50.toFixed(1) : '—',
    lo: p ? p.q25.toFixed(1) : '—',
    hi: p ? p.q90.toFixed(1) : '—',
    count: String(model.count),
    medianInterval: model.median.toFixed(1),
    firstDate: fmtDateIn(model.firstAt, CJK),
    last: fmtDateTimeIn(model.lastAt, CJK),
    updated: fmtDateTimeIn(model.generatedAt, CJK),
  };
}

/* ------------------------------ 卡片 ------------------------------ */

// 判定档位 → 卡片用色。与 src/index.html 的 .v-calm/.v-watch/.v-long/.v-rare 一致
const TONE = {
  'v-calm': PALETTE.bamboo,
  'v-watch': PALETTE.lan,
  'v-long': '#8A6A28',
  'v-rare': PALETTE.cinnabar,
};

const M = 100; // 左右留白：核心内容全部落在中心 1000×500 安全区内
const CONTENT_W = OG_W - 2 * M;
const CHART_H = 152; // 图表在成图里的最终高度

// 品牌标几何：贴在标题左侧，标题与副标题整体右移让位。
// y 取在「标题 cap top（约 100.6）+ 副标题底（约 180）」这段文字的视觉中线上。
const LOGO = { x: M, y: 112, size: 56, radius: 14, gap: 20 };
const TEXT_X = M + LOGO.size + LOGO.gap;

// 所有纵向锚点收在一处，方便整体调版，也让「核心内容在安全区内」可被断言
const LY = {
  pill: 72,
  title: 138,
  subtitle: 176,
  divider: 206,
  statLabel: 260,
  statValue: 328,
  statNote: 358,
  chart: 384,
  footer: 574,
};

/**
 * 布局契约。tech-selection 五：微信 / X 会裁切信息流里的预览图，
 * 核心数字必须落在**中心 1000×500**（1200×630 的中心）之内。
 * 测试直接断言这几个值，改版时越界会立刻失败。
 */
export const OG_LAYOUT = {
  safe: { x0: M, x1: OG_W - M, y0: (OG_H - 500) / 2, y1: (OG_H + 500) / 2 },
  margin: M,
  contentW: CONTENT_W,
  logo: { x: LOGO.x, y: LOGO.y, size: LOGO.size, radius: LOGO.radius },
  textX: TEXT_X,
  statLabelY: LY.statLabel,
  statValueY: LY.statValue,
  statValueSize: 58,
  statNoteY: LY.statNote,
  chartY: LY.chart,
  chartBottom: LY.chart + CHART_H,
  footerY: LY.footer,
};

// 场景按 760 宽渲染、再放大到 1000。
// 图内文字是**绝对字号**（wideLayout 的 11px），直接按 1000 宽出图，
// 缩到信息流缩略图里只剩 4~5px，等于没有。渲染得越窄、放大倍数越大，
// 文字在成图里就越大 —— 和 compactLayout 那条注释是同一个道理的反向用法。
const SCENE_W = 760;
const SCENE_SCALE = CONTENT_W / SCENE_W;
const SCENE_H = Math.round(CHART_H / SCENE_SCALE);

const txt = (x, y, s, o = {}) =>
  `<text x="${x}" y="${y}" font-size="${o.size ?? 16}"` +
  ` font-family='${o.mono ? MONO : SANS}'` +
  `${o.weight ? ` font-weight="${o.weight}"` : ''}` +
  `${o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : ''}` +
  ` fill="${o.fill ?? PALETTE.ink}">${esc(s)}</text>`;

/**
 * 一列指标：标签 / 大数字 + 单位 / 脚注。
 * 数字用等宽字体，两列并排时小数点才对得齐。
 */
function statCol(x, label, value, unit, note) {
  const vw = estimateTextWidth(value, OG_LAYOUT.statValueSize, true);
  return [
    txt(x, LY.statLabel, label, { size: 16, fill: PALETTE.mist }),
    txt(x, LY.statValue, value, { size: OG_LAYOUT.statValueSize, weight: 700, mono: true }),
    unit ? txt(x + vw + 10, LY.statValue, unit, { size: 20, fill: PALETTE.ink2 }) : '',
    txt(x, LY.statNote, note, { size: 15, fill: PALETTE.mist }),
  ].join('\n');
}

/** 右上角判定胶囊。宽度按文字估算，避免长短文案撑破或留白过多 */
function verdictPill(model) {
  const tone = verdictOf(model);
  const color = TONE[tone.cls] ?? PALETTE.lan;
  const w = Math.round(estimateTextWidth(tone.text, 15)) + 32;
  const x = M + CONTENT_W - w;
  return {
    text: tone.text,
    html:
      `<rect x="${x}" y="${LY.pill}" width="${w}" height="32" rx="16"` +
      ` fill="${color}" fill-opacity="0.09" stroke="${color}" stroke-opacity="0.34"/>` +
      txt(x + w / 2, LY.pill + 21, tone.text, { size: 15, fill: color, anchor: 'middle' }),
  };
}

export function buildOgSvg({ model, prediction, siteUrl }) {
  const n = ogNumbers(model, prediction);
  const pill = verdictPill(model);

  const scene = survivalScene(model, { width: SCENE_W, height: SCENE_H });
  const { defs, body } = renderSceneSvg(scene);

  const host = siteUrl ? siteUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}" viewBox="0 0 ${OG_W} ${OG_H}">
<defs>
<radialGradient id="ogGlowL" gradientUnits="userSpaceOnUse" cx="150" cy="0" r="620">
<stop offset="0%" stop-color="${PALETTE.lan}" stop-opacity="0.09"/>
<stop offset="100%" stop-color="${PALETTE.lan}" stop-opacity="0"/>
</radialGradient>
<radialGradient id="ogGlowR" gradientUnits="userSpaceOnUse" cx="1050" cy="60" r="560">
<stop offset="0%" stop-color="${PALETTE.bamboo}" stop-opacity="0.08"/>
<stop offset="100%" stop-color="${PALETTE.bamboo}" stop-opacity="0"/>
</radialGradient>
${defs}
<clipPath id="logoClip">
<rect x="${LOGO.x}" y="${LOGO.y}" width="${LOGO.size}" height="${LOGO.size}" rx="${LOGO.radius}"/>
</clipPath>
</defs>
<rect width="${OG_W}" height="${OG_H}" fill="${PALETTE.paper}"/>
<rect width="${OG_W}" height="${OG_H}" fill="url(#ogGlowL)"/>
<rect width="${OG_W}" height="${OG_H}" fill="url(#ogGlowR)"/>
<rect x="0" y="0" width="${OG_W}" height="3" fill="${PALETTE.lan}" fill-opacity="0.45"/>

${txt(TEXT_X, LY.title, '等 TIBO 按按钮', { size: 52, weight: 700 })}
${txt(TEXT_X, LY.subtitle, '额度重置观测台 · CODEX RESET WATCH', { size: 18, fill: PALETTE.mist })}
<image x="${LOGO.x}" y="${LOGO.y}" width="${LOGO.size}" height="${LOGO.size}"
 clip-path="url(#logoClip)" href="${logoHref()}"/>
${pill.html}

<line x1="${M}" y1="${LY.divider}" x2="${OG_W - M}" y2="${LY.divider}" stroke="${PALETTE.line}" stroke-width="1"/>

${statCol(M, '距上次重置', n.elapsed, '天', `自 ${n.last} 起`)}
${statCol(M + 334, '中位剩余等待', n.remaining, '天', `历史中位间隔 ${n.medianInterval} 天 · 80% 区间 ${n.lo}–${n.hi} 天`)}
${statCol(M + 668, '历史记录', n.count, '次', `${n.firstDate} 起`)}
<g transform="translate(${M},${LY.chart}) scale(${SCENE_SCALE.toFixed(4)})">
${body}
</g>

${txt(M, LY.footer, `最近一次采集 ${n.updated} 北京时间`, {
    size: 16,
    fill: PALETTE.mist,
  })}
${host ? txt(OG_W - M, LY.footer, host, { size: 16, fill: PALETTE.mist, anchor: 'end' }) : ''}
</svg>`;
}

/* ------------------------------ 出图 ------------------------------ */

/**
 * 生成 OG 图。
 *
 * @returns {Promise<null|{png:Buffer, svg:string, numbers:object, imageUrl:string|null, pageUrl:string|null, description:string}>}
 *   找不到中文字体时返回 null（调用方负责提示，不产出一张方框图）。
 */
export async function buildOgImage({ model, prediction, siteUrl, fontDirs }) {
  const font = detectCjkFont(fontDirs);
  if (!font) return null;

  const svg = buildOgSvg({ model, prediction, siteUrl });

  const rendered = new Resvg(svg, {
    loadSystemFonts: true,
    font: { loadSystemFonts: true, defaultFontFamily: 'Noto Sans CJK SC' },
  }).render();

  const base = siteUrl ? siteUrl.replace(/\/+$/, '') : '';
  const numbers = ogNumbers(model, prediction);

  return {
    png: rendered.asPng(),
    svg,
    numbers,
    font,
    width: rendered.width,
    height: rendered.height,
    pageUrl: base || null,
    imageUrl: base ? `${base}/og-image.png` : null,
    description:
      `距上次重置 ${numbers.elapsed} 天，中位剩余等待 ${numbers.remaining} 天` +
      `（80% 区间 ${numbers.lo}–${numbers.hi} 天）。` +
      `基于 ${numbers.count} 次历史重置记录自动生成。`,
  };
}

/* ------------------------------ 单独运行 ------------------------------ */

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const read = async (p) => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'));
  const [resets, statsFile] = await Promise.all([read('data/resets.json'), read('data/stats.json')]);
  const now = Date.now();
  const chartData = buildChartData(resets.records, now);
  const prediction = predictAll(resets.records, { now });
  const model = { ...chartData, generatedAt: statsFile.generated_at ?? new Date(now).toISOString() };

  const og = await buildOgImage({ model, prediction, siteUrl: process.env.SITE_URL ?? '' });
  if (!og) {
    console.error('✗ 未找到中文字体，跳过出图。Linux 下请先装 fonts-noto-cjk。');
    process.exit(1);
  }
  await mkdir(resolve(ROOT, 'dist'), { recursive: true });
  await writeFile(resolve(ROOT, 'dist/og-image.png'), og.png);
  await writeFile(resolve(ROOT, 'dist/og-image.svg'), og.svg, 'utf8');
  console.log(`✓ dist/og-image.png  ${(og.png.length / 1024).toFixed(1)} KB  ${og.width}×${og.height}`);
  console.log(`  字体：${og.font}`);
  console.log(`  og:image ${og.imageUrl ?? '（SITE_URL 未设置，已跳过）'}`);
}
