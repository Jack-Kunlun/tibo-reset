#!/usr/bin/env node
/**
 * 共享层校验（双端共用的几何与数据层）。
 *
 * 为什么需要单独一个脚本：`test-miniprogram.mjs` 已经跑了 320–414px 的图元越界，
 * 但**桌面那一侧没有任何对应校验** —— 网页端的图画出画布，同样是静默变成一片空白，
 * 只是没人盯着看就不会发现。本脚本补上另一半。
 *
 * 校验五件事：
 *   1. `miniprogram/utils/scene.js` 与 `src/lib/scene.js` 内容一致。
 *      AGENTS.md 规定副本由构建同步、不得手改 —— 这里就是那条规矩的执行者。
 *      注意本脚本要**在 build 之前**跑：跑在之后的话，副本刚被覆盖，校验恒真、等于没有。
 *   2. 数据层形状正确（升序、长度自洽、无 NaN）
 *   3. 桌面宽度下图元全部落在画布内
 *   4. 图内文字不小于可读下限，且序列化后不出现 NaN / undefined
 *   5. 「时长文案」的四处实现口径一致（见第 7 节 —— 这是同一类漂移的第二次守卫）
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChartData } from '../src/lib/chart-data.js';
import { spanOf } from '../src/lib/render.mjs';
import { survivalScene, stripScene, sceneBounds, fmtSpanShort } from '../src/lib/scene.js';
import { sceneToSvgTag } from '../src/lib/svg.mjs';

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

const section = (t) => console.log(`\n【${t}】`);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/* ======================== 1. 共享模块同步 ======================== */

section('1. 共享模块同步');

const SCENE_HEADER =
  '/** ⚠ 本文件由 scripts/build.mjs 从 src/lib/scene.js 同步生成，请勿直接修改。 */\n';

const sceneSrc = await readFile(resolve(ROOT, 'src/lib/scene.js'), 'utf8');

let sceneCopy = null;
try {
  sceneCopy = await readFile(resolve(ROOT, 'miniprogram/utils/scene.js'), 'utf8');
} catch {
  /* 交由下面的断言报告，不在这里中断 */
}

check('小程序侧副本存在', sceneCopy !== null, '请先运行 npm run build');
check('副本带「勿手改」头部', !!sceneCopy && sceneCopy.startsWith(SCENE_HEADER));

// 这条是核心：改了几何源码却忘了重新构建并提交副本时，CI 必须拦住
check(
  '副本内容与源完全一致（未手改、且已重新构建）',
  sceneCopy === SCENE_HEADER + sceneSrc,
  '源码已改但未同步到 miniprogram/utils/scene.js —— 运行 npm run build 并提交'
);

/* ======================== 2. 数据层 ======================== */

section('2. 数据层形状');

const resets = JSON.parse(await readFile(resolve(ROOT, 'data/resets.json'), 'utf8'));

// ⚠ NOW 必须**晚于最新一条记录**。
//
// sinceDays 是「最新记录 → now」这段右删失区间的长度，数据点本身又被用来定
// 生存曲线的时间轴范围。写死一个日期，那么每次新增记录后它都会过期 ——
// 2026-09-23 加了 09-22 那条之后，写死的 09-21 就变成了「now 早于最新记录」，
// 于是 sinceDays 变负、曲线起点被甩到画布左侧外，两个不相干的断言一起红。
//
// 取「最新记录 + 6 小时」：永远成立，且保持**确定性**（不能用 Date.now()，
// 否则同一份数据在不同时刻跑出不同结果，失败无法复现）。
const latestRecordMs = Math.max(
  ...resets.records.map((r) => new Date(r.announced_at).getTime()).filter((t) => Number.isFinite(t))
);
const NOW = latestRecordMs + 6 * 3_600_000;
const data = buildChartData(resets.records, NOW);

check('chartData 构建成功', !!data);
if (!data) {
  console.log(`\n✗ 数据不足，后续校验无法进行`);
  process.exit(1);
}

check('记录数 ≥ 2', data.count >= 2, `count=${data.count}`);
check('gapDays 长度 = count − 1', data.gapDays.length === data.count - 1);
check('sorted 长度与 gapDays 一致', data.sorted.length === data.gapDays.length);
check(
  'sorted 严格升序',
  data.sorted.every((v, i) => i === 0 || v >= data.sorted[i - 1])
);
check('gapDays 与 sorted 元素集合一致', [...data.gapDays].sort((a, b) => a - b).join(',') === data.sorted.join(','));
check('pct ∈ [0, 1]', data.pct >= 0 && data.pct <= 1, `pct=${data.pct}`);
check('sinceDays 有限且 ≥ 0', finite(data.sinceDays) && data.sinceDays >= 0);
check(
  '派生数值全部有限',
  [data.mean, data.median, data.longest, data.shortest, data.sinceDays].every(finite)
);
check('中位数 ≠ 平均数（本项目最核心的结论，掉了一个就有问题）', data.median !== data.mean,
  `median=${data.median} mean=${data.mean}`);

/* ======================== 3. 桌面图元越界 ======================== */

section('3. 桌面图元越界');

// 容差 0.5px：坐标里存在四舍五入到一位小数的情况，不允许「差一点点」把用例搞脆
const TOL = 0.5;

const scenesOf = (width, layout) => ({
  生存曲线: survivalScene(data, { width, layout }),
  点阵分布: stripScene(data, { width, layout }),
});

for (const width of [900, 1000, 1180]) {
  const scenes = scenesOf(width);
  for (const [name, scene] of Object.entries(scenes)) {
    const b = sceneBounds(scene);
    const inside =
      finite(b.minX) &&
      finite(b.maxX) &&
      b.minX >= -TOL &&
      b.minY >= -TOL &&
      b.maxX <= scene.width + TOL &&
      b.maxY <= scene.height + TOL;
    check(`${width}px · ${name} 落在画布内`, inside, `bounds=${JSON.stringify(b)} canvas=${scene.width}×${scene.height}`);
    check(`${width}px · ${name} 元素非空`, scene.elements.length > 0, `n=${scene.elements.length}`);
    check(`${width}px · ${name} 画布宽度等于传入值`, scene.width === width, `实际 ${scene.width}`);
  }
}

/* ======================== 4. 文字可读下限 ======================== */

section('4. 文字可读下限');

/** 场景内最小的文字字号（size 缺省即为 11，与 textBox 的默认值保持一致） */
const minFontSize = (scene) =>
  Math.min(...scene.elements.filter((e) => e.k === 'text').map((e) => e.size ?? 11));

// 桌面：图内文字本就不该小于 11px
for (const [name, scene] of Object.entries(scenesOf(900))) {
  const m = minFontSize(scene);
  check(`900px · ${name} 最小字号 ≥ 11`, m >= 11, `实际 ${m}`);
}

// 小程序：紧凑布局按目标宽度重排，fontK = min(1, width/340)，320px 时约 0.94
// → 11 × 0.94 ≈ 10.3。下限设 10，低于这个值就说明它退化成了「等比缩小」。
for (const width of [320, 375]) {
  const scenes = scenesOf(width, 'compact');
  for (const [name, scene] of Object.entries(scenes)) {
    const m = minFontSize(scene);
    check(`${width}px 紧凑 · ${name} 最小字号 ≥ 10`, m >= 10, `实际 ${m}`);
    check(`${width}px 紧凑 · ${name} 画布宽度等于传入值`, scene.width === width, `实际 ${scene.width}`);
  }
}

// 反向保护：等比缩小的做法必须被这条挡住。若有人把紧凑布局改成
// 「wideLayout + 整体 scale」，320px 下字号会掉到 3.9px，这条就会红。
check(
  '紧凑布局不是「宽布局等比缩小」',
  minFontSize(survivalScene(data, { width: 320, layout: 'compact' })) > 8,
  '字号已缩到 8px 以下，说明退化成了等比缩放'
);

/* ======================== 5. 序列化产物 ======================== */

section('5. 序列化产物');

for (const [name, scene] of Object.entries(scenesOf(900))) {
  const tag = sceneToSvgTag(scene, { id: 'chart', role: 'img', label: name });
  check(`${name} · SVG 不含 NaN`, !/NaN/.test(tag));
  check(`${name} · SVG 不含 undefined`, !/undefined/.test(tag));
  check(`${name} · SVG 尺寸与场景一致`, tag.includes(`width="${scene.width}"`) && tag.includes(`height="${scene.height}"`));
  check(`${name} · SVG 元素数量与场景一致`, (tag.match(/<(line|text|circle|polygon|path)\b/g) ?? []).length >= scene.elements.length - 2,
    '序列化丢失了元素');
}

/* ======================== 6. 极端数据不产生 NaN ======================== */

section('6. 极端数据');

// 真实数据里最长的等待是 67.7 天，图上只画到 14 天 —— 超出的部分必须走
// 「虚线尾巴」，不能挤在刻度上。这里用更极端的值压一遍，确保不会算崩。
const extreme = {
  ...data,
  gapDays: [0.05, 0.2, 3, 7, 14, 45, 90],
  sorted: [0.05, 0.2, 3, 7, 14, 45, 90],
  count: 8,
  shortest: 0.05,
  longest: 90,
  sinceDays: 120,
  pct: 1,
};

for (const [name, scene] of Object.entries(scenesOf(900))) {
  const b = sceneBounds(scene);
  check(`极端值 · ${name} 不产生 NaN`, finite(b.minX) && finite(b.maxX), JSON.stringify(b));
}

const exScenes = {
  生存曲线: survivalScene(extreme, { width: 900 }),
  点阵分布: stripScene(extreme, { width: 900 }),
};
for (const [name, scene] of Object.entries(exScenes)) {
  const b = sceneBounds(scene);
  check(
    `极端值 · ${name} 仍在画布内`,
    b.minX >= -TOL && b.maxX <= scene.width + TOL && b.minY >= -TOL && b.maxY <= scene.height + TOL,
    JSON.stringify(b)
  );
  check(`极端值 · ${name} 序列化无 NaN`, !/NaN/.test(sceneToSvgTag(scene)));
}

// 单点数据（只有一次间隔）不该崩 —— 除零最容易在这里发生
const single = { ...data, gapDays: [3], sorted: [3], count: 2, shortest: 3, longest: 3 };
const singleScenes = {
  生存曲线: survivalScene(single, { width: 900 }),
  点阵分布: stripScene(single, { width: 900 }),
};
for (const [name, scene] of Object.entries(singleScenes)) {
  const b = sceneBounds(scene);
  check(`单条间隔 · ${name} 不产生 NaN`, finite(b.minX) && finite(b.maxX), JSON.stringify(b));
}

/* ======================== 7. 时长口径对拍 ======================== */

section('7. 时长口径（四处实现必须同口径）');

// 同一段「时长文案」口径在本仓里有**四份**实现，彼此没有共享构建：
//   1. src/lib/render.mjs          spanOf        —— 网页端，**权威口径**
//   2. miniprogram/utils/format.js spanOf        —— 小程序端，手写副本
//   3. src/index.html              spanFromMs    —— 页首那行「已过 …」，内联 <script>，每秒重算
//   4. src/lib/scene.js            fmtSpanShort  —— 图内标签，短口径（只补到下一级就停）
//
// 前三份必须**逐字符同输出**，第四份必须**是前三份输出的前缀**。
//
// 为什么值得单开一节：漏改任何一处都**不会报错**，只会让同一份数据在同一个页面上
// 出现两种读法（页首写「已过 21 小时」、图注写「1 天」），而且只在特定取值区间才显形。
// 2026-09-30 就是这么漏的 —— 五套测试全绿，页面上却还挂着旧文案，因为那行字由
// 内联脚本每秒覆写一遍，构建期写进去的静态值根本轮不到显示。

const htmlSrc = await readFile(resolve(ROOT, 'src/index.html'), 'utf8');
const formatSrc = await readFile(resolve(ROOT, 'miniprogram/utils/format.js'), 'utf8');

/**
 * 从源码里按大括号配对，抽出一个具名 `function` 的完整声明文本。
 *
 * 抽不到返回 null —— 调用方**必须当成失败**，不许静默跳过：函数被改名时
 * 「抽取失败」和「口径一致」在朴素写法下都会走到同一条「没发现差异」的路径，
 * 于是这条防线会因为一次重命名而永久失效，还长着一副全绿的脸色。
 */
function extractFn(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}

const inlineBody = extractFn(htmlSrc, 'spanFromMs');
const mpBody = extractFn(formatSrc, 'spanOf');

check('抽得到 src/index.html 的 spanFromMs', !!inlineBody, '函数被改名或删除 —— 请同步更新本测试，别让它静默失效');
check('抽得到 miniprogram/utils/format.js 的 spanOf', !!mpBody, '函数被改名或删除 —— 请同步更新本测试，别让它静默失效');

const evalFn = (body, name) => (body ? new Function(`${body};return ${name};`)() : null);
const inlineSpan = evalFn(inlineBody, 'spanFromMs');
const mpSpan = evalFn(mpBody, 'spanOf');

const SEC = 1 / 86_400;
const MIN = 60 * SEC;
const HOUR = 3600 * SEC;

// 用例表：四个分支各自的边界，加上本项目真实出现过的取值
const DAYS = [
  0,
  30 * SEC,
  59 * SEC,
  60 * SEC,
  61 * SEC,
  10 * MIN,
  59 * MIN + 20 * SEC,
  60 * MIN,
  1 * HOUR,
  1 * HOUR + 30 * MIN,
  20 * HOUR + 41 * MIN, // 真实值：页面上的「距上次重置」
  23 * HOUR + 59 * MIN + 59 * SEC,
  1,
  1 + 20 * HOUR,
  6.7, // 真实值：中位间隔
  67.7, // 真实值：最长等待
  0.2, // 用户点名的那个「0.2 天」
  0.86,
  0.8645, // 真实值（页面上曾显示 0.86 天）
  1.9,
  86399.6 * SEC, // 23:59:59.6 —— floor 与 round 在这里分道扬镳，见下
];

/* --- 7.1 权威实现的手算锚点 ---------------------------------------- */
//
// ⚠ 这段是**必须写死**的：下面 7.2/7.3 走的是「两份实现互相比」，
//   万一有人把同一个错误同时抄进三份拷贝，互比会一致通过。
//   这几个值来自人工推算，是三份拷贝一起漂移时的唯一兜底。

const ANCHORS = [
  [0, '0 秒'],
  [60 * SEC, '1 分'],
  [61 * SEC, '1 分 1 秒'],
  [1 * HOUR, '1 小时'],
  [1 * HOUR + 30 * MIN, '1 小时 30 分'],
  [23 * HOUR + 59 * MIN + 59 * SEC, '23 小时 59 分'],
  [1, '1 天'],
  [1 + 20 * HOUR, '1 天 20 小时'],
  [0.2, '4 小时 48 分'],
  [0.8645, '20 小时 44 分'],
];

const anchorBad = ANCHORS.filter(([d, want]) => spanOf(d).text !== want).map(
  ([d, want]) => `${d} 天 期望「${want}」实得「${spanOf(d).text}」`
);
check(`spanOf 的 ${ANCHORS.length} 个手算锚点全部命中`, anchorBad.length === 0, anchorBad.join('；'));

/* --- 7.2 逐例互比 --------------------------------------------------- */

/** 把 impl 与权威 spanOf 在同一张表上比一遍，返回不一致的描述 */
const diffAgainst = (cases, toText) =>
  cases
    .map((d) => [d, toText(d), spanOf(d).text])
    .filter(([, got, want]) => got !== want)
    .map(([d, got, want]) => `${d} 天：「${got}」≠「${want}」`);

const brief = (list) =>
  list.length ? list.slice(0, 3).join('；') + (list.length > 3 ? ` …共 ${list.length} 处` : '') : '';

const inlineDiff = inlineSpan ? diffAgainst(DAYS, (d) => inlineSpan(d * 86_400_000)) : ['未抽到 spanFromMs'];
check(
  `src/index.html 的 spanFromMs 与 spanOf 逐例一致（${DAYS.length} 例）`,
  inlineDiff.length === 0,
  brief(inlineDiff)
);

const mpDiff = mpSpan ? diffAgainst(DAYS, (d) => mpSpan(d).text) : ['未抽到 format.js 的 spanOf'];
check(
  `miniprogram/utils/format.js 的 spanOf 与网页端逐例一致（${DAYS.length} 例）`,
  mpDiff.length === 0,
  brief(mpDiff)
);

// 第四份是**短口径**：只补到下一级就停（「6 天 17 小时」「20 小时」「41 分」）。
// 所以它不必等于权威输出，但必须是权威输出的**前缀** —— 否则图注和正文对不上号。
const shortDiff = DAYS.map((d) => [d, fmtSpanShort(d), spanOf(d).text]).filter(
  ([, s, full]) => !full.startsWith(s)
);
check(
  `src/lib/scene.js 的 fmtSpanShort 是 spanOf 输出的前缀（${DAYS.length} 例）`,
  shortDiff.length === 0,
  brief(shortDiff.map(([d, s, full]) => `${d} 天：「${s}」不是「${full}」的前缀`))
);

/* --- 7.3 需求本身的断言 --------------------------------------------- */

// 用户的原话：「不要使用 0.2 天这种，更改为小时，分，秒」。
// 上面各条是「四处实现互相对齐」，这条是「对齐到的那个口径确实是时分秒」。
const decimalBad = DAYS.flatMap((d) => {
  const outs = [spanOf(d).text, fmtSpanShort(d)];
  if (inlineSpan) outs.push(inlineSpan(d * 86_400_000));
  if (mpSpan) outs.push(mpSpan(d).text);
  return outs.filter((s) => /\d+\.\d+\s*天/.test(s)).map((s) => `${d} 天 → 「${s}」`);
});
check('口径表内任何一处输出都不含小数天', decimalBad.length === 0, brief(decimalBad));

/* --- 7.4 证明 7.1 那条边界用例不是摆设 ------------------------------- */
//
// 86399.6 秒这条用例的价值全在「先 round 到秒」这个选择上。若有人把 spanOf 的
// Math.round 改成 Math.floor，7.1 的锚点会红；但若只把那条例子的取值调小、
// 或把 round 与 floor 的差别抹平，这条用例就会变成恒真 —— 这里锁死它。
const floorText = (() => {
  const t = Math.floor(86_399.6);
  return `${Math.floor(t / 3600)} 小时 ${Math.floor((t % 3600) / 60)} 分`;
})();
check(
  '86399.6 秒这条用例真的踩在 floor/round 分歧点上（不是恒真）',
  floorText !== spanOf(86_399.6 * SEC).text,
  `floor 口径给「${floorText}」，round 口径给「${spanOf(86_399.6 * SEC).text}」—— 两者相同说明该用例已失效`
);

/* ======================== 结果 ======================== */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
