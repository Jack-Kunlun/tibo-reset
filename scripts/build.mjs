#!/usr/bin/env node
/**
 * 构建脚本。一次产出三样东西：
 *
 *   1. dist/index.html           网页（单文件，图表 SVG 已在构建期渲染好）
 *   2. dist/og-image.png         F8 分享卡片预览图（缺中文字体时跳过）
 *   3. miniprogram/data/snapshot.js  小程序首屏数据快照
 *   4. miniprogram/utils/scene.js    共享几何模块的同步副本
 *
 * 为什么小程序要有快照：小程序的 request 合法域名必须 ICP 备案，
 * 域名没配好之前整个页面会白屏。快照让小程序**离线也能出完整首屏**，
 * 联网后再用 /api/state 覆盖 —— 部署失败不会变成事故。
 */
import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChartData } from '../src/lib/chart-data.js';
import { predictAll } from '../src/lib/predict.mjs';
import { detectSignals } from '../src/lib/signals.mjs';
import { buildOgImage } from './og-image.mjs';
import { renderAll } from './render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = async (p) => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'));

/**
 * 品牌标内联成 data URI。
 *
 * 为什么内联而不是让 HTML 引一个 logo.png：产物要能**单独拿走就成立**（本项目页面只有一个 HTML）。
 * 图标则相反 —— 浏览器是独立地、自主地发请求去取 favicon 的，内联不可靠（Safari 尤其），
 * 所以那两个 png 走独立文件。两者取舍不同，不是不一致。
 */
async function logoDataUri() {
  const buf = await readFile(resolve(ROOT, 'src/assets/logo-96.png'));
  return `data:image/png;base64,${buf.toString('base64')}`;
}
const ACCOUNT = process.env.SOURCE_ACCOUNT ?? 'thsottiaux';
const SCENE_HEADER =
  '/** ⚠ 本文件由 scripts/build.mjs 从 src/lib/scene.js 同步生成，请勿直接修改。 */\n';

/* ------------------------------ 读入 ------------------------------ */

const [resets, tweets, statsFile, template] = await Promise.all([
  read('data/resets.json'),
  read('data/tweets.json'),
  read('data/stats.json'),
  readFile(resolve(ROOT, 'src/index.html'), 'utf8'),
]);

// 固定一个 now，让同一轮构建里所有派生结果共用同一时刻。
// BUILD_NOW 可以把它钉死（ISO 串或毫秒数）—— 「同一份数据 + 同一个时刻 → 同一份产物」，
// 这是可复现构建的前提，也是验收 A8（时间显示不随机器时区变化）能精确判等的基础。
const now = pickNow(process.env.BUILD_NOW);

function pickNow(raw) {
  if (!raw) return Date.now();
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return asDate;
  throw new Error(`BUILD_NOW 无法解析：${raw}（应为 ISO 时间串或毫秒时间戳）`);
}

if (process.env.BUILD_NOW) console.log(`▸ 构建时刻已固定为 ${new Date(now).toISOString()}（BUILD_NOW）`);

const chartData = buildChartData(resets.records, now);
if (!chartData) throw new Error('记录不足（至少需要 2 条带时间的记录），无法构建');

const prediction = predictAll(resets.records, { now });
const signals = detectSignals(tweets.tweets, { now, account: ACCOUNT });

// 页面与卡片共用同一个 model，数字不可能对不上
const model = { ...chartData, generatedAt: statsFile.generated_at ?? new Date(now).toISOString() };

/* -------------------------- F8 分享卡片 -------------------------- */

// SITE_URL 决定 og:url / og:image 的绝对地址。没配就不输出这两条 meta ——
// 宁可少两条，也不给平台一个抓不到的域名（抓不到会展开成空白卡）。
const SITE_URL = (process.env.SITE_URL ?? '').trim().replace(/\/+$/, '');
const og = await buildOgImage({ model, prediction, siteUrl: SITE_URL });
if (!og) {
  console.warn(
    '⚠ 未找到中文字体，已跳过 OG 分享图；og:image / og:url 不会输出。\n' +
      '  macOS 自带中文字体，Linux 需先装 fonts-noto-cjk（见 .github/workflows/collect.yml）。'
  );
} else if (!SITE_URL) {
  console.warn('⚠ 未设置 SITE_URL，OG 图已生成但不会写进 og:image（平台抓不到相对地址）。');
}

/* ---------------------------- 网页 ---------------------------- */

const parts = renderAll(model, prediction, signals, {
  og,
  // 采集异常必须显示在页面上，不能只留在 CI 日志里 ——
  // 发布链已改成「采集失败不阻断」（见 .github/workflows/collect.yml 的注释），
  // 页面会在数据陈旧时照常上线，那就必须自己把这件事说出来。
  //
  // lastLiveAt 取 tweets.json 的 `updated_at`：它只在实时采集**成功**时才推进。
  // 不要换成 statsFile.generated_at —— 那个每轮都刷新，采集失败时记的是失败时刻。
  collect: {
    errors: statsFile.errors ?? [],
    attemptedAt: statsFile.generated_at ?? null,
    lastLiveAt: tweets.updated_at ?? null,
  },
});

// 品牌标在构建期内联成 data URI，走与其他占位符同一套替换机制
parts.LOGO_URI = await logoDataUri();

// 用函数式替换：字符串形式的 replace 会把内容里的 $& / $1 当特殊序列处理
let html = template;
for (const [key, value] of Object.entries(parts)) {
  const token = `<!--__${key.toUpperCase()}__-->`;
  if (!html.includes(token)) throw new Error(`模板缺少占位符 ${token}`);
  html = html.replace(token, () => value);
}

// 兜底：任何未替换的占位符都视为构建失败，避免静默产出空白页面
const leftover = html.match(/<!--__[A-Z_]+__-->/g);
if (leftover) throw new Error(`存在未替换的占位符：${leftover.join(', ')}`);

await mkdir(resolve(ROOT, 'dist'), { recursive: true });
await writeFile(resolve(ROOT, 'dist/index.html'), html, 'utf8');
if (og) await writeFile(resolve(ROOT, 'dist/og-image.png'), og.png);

// 图标拷贝成独立文件（理由见 logoDataUri 的注释）。
// Pages 发布的是整个 dist/（collect.yml 里 upload-pages-artifact 的 path），
// 所以这两个文件会随之自动上线，无需在 workflow 里另行声明。
await copyFile(resolve(ROOT, 'src/assets/favicon-32.png'), resolve(ROOT, 'dist/favicon.png'));
await copyFile(
  resolve(ROOT, 'src/assets/apple-touch-icon-180.png'),
  resolve(ROOT, 'dist/apple-touch-icon.png')
);

/* -------------------------- 小程序快照 -------------------------- */

const snapshot = {
  schema: 1,
  generatedAt: new Date(now).toISOString(),
  dataUpdatedAt: statsFile.generated_at ?? null,
  account: ACCOUNT,
  chart: chartData,
  prediction,
  signals,
  stats: statsFile.stats ?? null,
  collectErrors: statsFile.errors ?? [],
};

const snapshotJs =
  '/** ⚠ 本文件由 scripts/build.mjs 生成，请勿直接修改。 */\n' +
  '// 离线首屏数据快照：采集脚本 → 构建 → 小程序内置。\n' +
  `export default ${JSON.stringify(snapshot, null, 2)};\n`;

await mkdir(resolve(ROOT, 'miniprogram/data'), { recursive: true });
await writeFile(resolve(ROOT, 'miniprogram/data/snapshot.js'), snapshotJs, 'utf8');

/* ------------------------ 共享模块同步 ------------------------ */

const sceneSrc = await readFile(resolve(ROOT, 'src/lib/scene.js'), 'utf8');
await mkdir(resolve(ROOT, 'miniprogram/utils'), { recursive: true });
await writeFile(resolve(ROOT, 'miniprogram/utils/scene.js'), SCENE_HEADER + sceneSrc, 'utf8');

/* ------------------------------ 汇总 ------------------------------ */

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
console.log(`✓ dist/index.html            ${kb(html)}  ${chartData.count} 条记录 · 图表已预渲染（品牌标已内联）`);
if (og) {
  console.log(`✓ dist/og-image.png          ${kb(og.png)}  ${og.width}×${og.height} 分享卡片`);
}
console.log('✓ dist/favicon.png            32×32    浏览器标签页图标');
console.log('✓ dist/apple-touch-icon.png   180×180  iOS 添加到主屏');
console.log(`✓ miniprogram/data/snapshot.js ${kb(snapshotJs)}  含预测与信号`);
console.log(`✓ miniprogram/utils/scene.js  ${kb(sceneSrc)}  共享几何已同步`);
console.log(
  `  信号：${signals.level}（明确 ${signals.signals.length} / 线索 ${signals.hints.length} / 扫描 ${signals.checkedTweets} 条）`
);
