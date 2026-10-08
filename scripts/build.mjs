#!/usr/bin/env node
/**
 * 构建脚本。一次产出三样东西：
 *
 *   1. dist/index.html           网页（单文件，图表 SVG 已在构建期渲染好）
 *   2. dist/og-image.png         F8 分享卡片预览图（缺中文字体时跳过）
 *   3. miniprogram/data/snapshot.js  小程序首屏数据快照
 *   4. miniprogram/utils/*.js        双端共享模块的同步副本（scene.js / outlook.mjs）
 *
 * 为什么小程序要有快照：小程序的 request 合法域名必须 ICP 备案，
 * 域名没配好之前整个页面会白屏。快照让小程序**离线也能出完整首屏**，
 * 联网后再用 /api/state 覆盖 —— 部署失败不会变成事故。
 */
import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { derive, logoDataUri, renderPage } from '../src/lib/page.mjs';
import { resolveBuildNow, snapshotFrom, writeSnapshot, SNAPSHOT_REL } from '../src/lib/snapshot.mjs';
import { buildOgImage } from './og-image.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = async (p) => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'));

const ACCOUNT = process.env.SOURCE_ACCOUNT ?? 'thsottiaux';

/**
 * 双端共用的模块：`src/lib/<name>` → `miniprogram/utils/<name>`，**逐字复制**。
 *
 * 为什么不各写一份：两端一旦各写一份，「预测什么时候重置」这件事就会有两个版本，
 * 而它们只在某个用户先看网页、再打开小程序时才会露出来。`scene.js` 是几何，
 * `outlook.mjs` 是结论 —— 结论比几何更不该漂移。
 *
 * 能被同步的前提是**自包含**：这两个文件都只有自己的内部依赖，不 import 任何
 * 仓库内其它模块（scene.js 连 `format.js` 都不引，自己带一份 `fmtSpanShort`）。
 * 所以加新条目之前先确认这一点，否则小程序端会在运行时报「找不到模块」。
 *
 * ⚠ 产物不入库之外的处理：副本**要入库**（真机上传时得在包里），
 *   但**只能由这里生成**；`test-shared.mjs` 会逐字节核对，手改必红。
 *   且那条核对必须跑在 build **之前**（跑在之后就成了「刚被覆盖所以恒真」）。
 */
const SHARED_MODULES = ['scene.js', 'outlook.mjs'];
const sharedHeader = (name) =>
  `/** ⚠ 本文件由 scripts/build.mjs 从 src/lib/${name} 同步生成，请勿直接修改。 */\n`;

/* ------------------------------ 读入 ------------------------------ */

const [resets, tweets, statsFile, template] = await Promise.all([
  read('data/resets.json'),
  read('data/tweets.json'),
  read('data/stats.json'),
  readFile(resolve(ROOT, 'src/index.html'), 'utf8'),
]);

// 固定一个 now，让同一轮构建里所有派生结果共用同一时刻（解析逻辑在同名模块里，
// `scripts/build-snapshot.mjs` 走的是同一个函数 —— 两条路必须锚在同一时刻上）。
const now = resolveBuildNow(process.env.BUILD_NOW);

if (process.env.BUILD_NOW) console.log(`▸ 构建时刻已固定为 ${new Date(now).toISOString()}（BUILD_NOW）`);

// 页面与卡片共用同一份派生值（同一份数据 + 同一个 now），数字不可能对不上。
// derive 内部会校验记录条数，不足时抛错。
const { chart: chartData, prediction, signals, model } = derive({
  resets,
  tweets,
  statsFile,
  now,
  account: ACCOUNT,
});

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

// 组装本身在 src/lib/page.mjs —— 后端请求时实时渲染走的是**同一个函数**，
// 所以「构建产物 = 线上页面」是同一套代码的结果，不是两份实现对表对出来的。
const html = renderPage({
  template,
  model,
  prediction,
  signals,
  og,
  // 采集异常必须显示在页面上，不能只留在日志里 ——
  // 发布链是「采集失败不阻断」，页面会在数据陈旧时照常上线，
  // 那就必须自己把这件事说出来。
  //
  // lastLiveAt 取 tweets.json 的 `updated_at`：它只在实时采集**成功**时才推进。
  // 不要换成 statsFile.generated_at —— 那个每轮都刷新，采集失败时记的是失败时刻。
  collect: {
    errors: statsFile.errors ?? [],
    attemptedAt: statsFile.generated_at ?? null,
    lastLiveAt: tweets.updated_at ?? null,
  },
  // 品牌标内联成 data URI，走与其他占位符同一套替换机制
  logoUri: await logoDataUri(),
});

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

// 组装与落盘都在 src/lib/snapshot.mjs。那份产物必须能**脱离本脚本单独重生成**：
// 它不入库，而小程序代码在模块顶层就 import 它，所以测试前置与开发者工具都得先
// 有它 —— 见该模块的注释（包括「为什么不能给测试前置塞一个完整构建」）。
const snapshotJs = snapshotFrom({
  chart: chartData,
  prediction,
  signals,
  statsFile,
  account: ACCOUNT,
  now,
});
await writeSnapshot(snapshotJs);

/* ------------------------ 共享模块同步 ------------------------ */

await mkdir(resolve(ROOT, 'miniprogram/utils'), { recursive: true });
const synced = [];
for (const name of SHARED_MODULES) {
  const src = await readFile(resolve(ROOT, `src/lib/${name}`), 'utf8');
  const dst = name.replace(/\.mjs$/, '.js');
  await writeFile(resolve(ROOT, `miniprogram/utils/${dst}`), sharedHeader(name) + src, 'utf8');
  synced.push({ dst, bytes: Buffer.byteLength(src) });
}

/* ------------------------------ 汇总 ------------------------------ */

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
console.log(`✓ dist/index.html            ${kb(html)}  ${chartData.count} 条记录 · 图表已预渲染（品牌标已内联）`);
if (og) {
  console.log(`✓ dist/og-image.png          ${kb(og.png)}  ${og.width}×${og.height} 分享卡片`);
}
console.log('✓ dist/favicon.png            32×32    浏览器标签页图标');
console.log('✓ dist/apple-touch-icon.png   180×180  iOS 添加到主屏');
console.log(`✓ ${SNAPSHOT_REL} ${kb(snapshotJs)}  含预测与信号`);
for (const s of synced) {
  console.log(`✓ miniprogram/utils/${s.dst}  ${(s.bytes / 1024).toFixed(1)} KB  共享模块已同步`);
}
console.log(
  `  信号：${signals.level}（已发生 ${signals.occurred?.length ?? 0} / 预告 ${signals.signals.length} / 线索 ${signals.hints.length} / 扫描 ${signals.checkedTweets} 条）`
);
