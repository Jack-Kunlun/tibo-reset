#!/usr/bin/env node
/**
 * F8 分享卡片校验。
 *
 * 这个脚本要挡住的是一类**静默失败**：卡片生成不报错，但产出的图是坏的或空的。
 * 最典型的一种是缺中文字体 —— resvg 不会抛错，它只是把每个汉字画成空方框，
 * 页面照样发布，直到有人在微信里分享出去才发现预览图是豆腐块。
 *
 * 校验四件事：
 *   1. 缺字体时**不出图**（守卫生效），而不是产出一张坏卡片
 *   2. 出图尺寸正确（1200×630）、无 NaN / undefined
 *   3. 核心数字落在中心 1000×500 安全区内（平台裁切后仍在）
 *   4. og:meta 的三种状态：有域名 / 无域名 / 需要转义
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChartData } from '../src/lib/chart-data.js';
import { predictAll } from '../src/lib/predict.mjs';
import { OG_H, OG_LAYOUT, OG_W, buildOgImage, detectCjkFont, ogNumbers } from './og-image.mjs';
import { renderOgMeta } from '../src/lib/render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/* ======================== 夹具：用真实数据 ======================== */

const read = async (p) => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'));
const [resets, statsFile] = await Promise.all([read('data/resets.json'), read('data/stats.json')]);

const now = Date.now();
const model = {
  ...buildChartData(resets.records, now),
  generatedAt: statsFile.generated_at ?? new Date(now).toISOString(),
};
const prediction = predictAll(resets.records, { now });
const numbers = ogNumbers(model, prediction);
const SITE = 'https://tibo.example.com';

/* ==================== 1. 缺字体时不出图 ==================== */

console.log('\n【缺字体时的降级行为】');

check(
  '探测逻辑：不存在的目录 → 判为没有中文字体',
  detectCjkFont(['/no/such/font/dir']) === null
);

const guarded = await buildOgImage({ model, prediction, siteUrl: SITE, fontDirs: [] });
check('缺字体时返回 null，不产出一张方框图', guarded === null, String(guarded));

/* ==================== 2. 本机字体与出图 ==================== */

console.log('\n【出图】');

const font = detectCjkFont();
check('本机存在中文字体', !!font, font ?? '未找到 —— Linux 下需 apt-get install fonts-noto-cjk');

const og = font ? await buildOgImage({ model, prediction, siteUrl: SITE }) : null;

if (!og) {
  failures.push('无法出图：缺少中文字体');
  console.log('  ✗ 出图校验未执行（缺字体），已在上面记为失败');
} else {
  check('PNG 尺寸 1200×630', og.width === OG_W && og.height === OG_H, `${og.width}×${og.height}`);
  check(
    'PNG 是有效图像且体积合理',
    og.png.length > 5000 && og.png.subarray(1, 4).toString('latin1') === 'PNG',
    `${(og.png.length / 1024).toFixed(1)} KB`
  );
  check('SVG 含站名', og.svg.includes('等 TIBO 按按钮'));
  check(
    '三个核心数字都画进图里',
    og.svg.includes(`>${numbers.elapsed}<`) &&
      og.svg.includes(`>${numbers.remaining}<`) &&
      og.svg.includes(`>${numbers.count}<`),
    `${numbers.elapsed} / ${numbers.remaining} / ${numbers.count}`
  );
  check('SVG 无 NaN / undefined / Infinity', !/NaN|undefined|Infinity/.test(og.svg));
  check(
    'og:image 是绝对地址',
    og.imageUrl === `${SITE}/og-image.png`,
    String(og.imageUrl)
  );
  check(
    'og:description 与图上的数字一致',
    og.description.includes(numbers.elapsed) &&
      og.description.includes(numbers.remaining) &&
      og.description.includes(numbers.count)
  );
}

/* ==================== 3. 安全区 ==================== */

console.log('\n【中心 1000×500 安全区】');

{
  const s = OG_LAYOUT.safe;
  const inSafeY = (y) => y >= s.y0 && y <= s.y1;
  const ascent = OG_LAYOUT.statValueSize * 0.82;

  check(`安全区与画布尺寸自洽`, s.x0 === 100 && s.x1 === OG_W - 100 && s.y0 === 65 && s.y1 === 565);
  check(
    `核心数字顶边不出安全区（${(OG_LAYOUT.statValueY - ascent).toFixed(0)} ≥ ${s.y0}）`,
    inSafeY(OG_LAYOUT.statValueY - ascent)
  );
  check(`指标标签在安全区内（y=${OG_LAYOUT.statLabelY}）`, inSafeY(OG_LAYOUT.statLabelY));
  check(`指标脚注在安全区内（y=${OG_LAYOUT.statNoteY}）`, inSafeY(OG_LAYOUT.statNoteY));
  check(
    `图表整体落在安全区内（${OG_LAYOUT.chartY}..${OG_LAYOUT.chartBottom}）`,
    OG_LAYOUT.chartY >= s.y0 && OG_LAYOUT.chartBottom <= s.y1
  );
  check('内容宽度未越过安全区边界', OG_LAYOUT.contentW <= s.x1 - s.x0);
}

/* ==================== 4. og:meta 三种状态 ==================== */

console.log('\n【og:meta】');

{
  const full = renderOgMeta({
    imageUrl: `${SITE}/og-image.png`,
    pageUrl: SITE,
    description: 'D',
  });
  check('配了域名：输出 og:image 绝对地址', full.includes(`property="og:image" content="${SITE}/og-image.png"`));
  check('配了域名：输出 og:url', full.includes(`property="og:url" content="${SITE}"`));
  check('配了域名：twitter:card 用大图', full.includes('name="twitter:card" content="summary_large_image"'));
  check(
    '声明图宽高（平台据此决定裁切）',
    full.includes('og:image:width" content="1200"') && full.includes('og:image:height" content="630"')
  );

  const bare = renderOgMeta(null);
  check(
    '未配域名：不输出 og:image / og:url（不给平台一个抓不到的地址）',
    !bare.includes('property="og:image"') && !bare.includes('property="og:url"')
  );
  check('未配域名：twitter:card 退化为 summary', bare.includes('name="twitter:card" content="summary"'));
  check(
    '未配域名：标题与描述仍完整',
    bare.includes('property="og:title"') && bare.includes('property="og:description"')
  );

  const quoted = renderOgMeta({ description: '带"引号"的&描述', imageUrl: null, pageUrl: null });
  check(
    '属性值转义：引号不会提前闭合 meta 标签',
    quoted.includes('&quot;') && quoted.includes('&amp;') && !quoted.includes('content="带"')
  );
}

/* ======================== 结果 ======================== */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
