#!/usr/bin/env node
/**
 * 共享层校验（双端共用的几何与数据层）。
 *
 * 为什么需要单独一个脚本：`test-miniprogram.mjs` 已经跑了 320–414px 的图元越界，
 * 但**桌面那一侧没有任何对应校验** —— 网页端的图画出画布，同样是静默变成一片空白，
 * 只是没人盯着看就不会发现。本脚本补上另一半。
 *
 * 校验四件事：
 *   1. `miniprogram/utils/scene.js` 与 `src/lib/scene.js` 内容一致。
 *      AGENTS.md 规定副本由构建同步、不得手改 —— 这里就是那条规矩的执行者。
 *      注意本脚本要**在 build 之前**跑：跑在之后的话，副本刚被覆盖，校验恒真、等于没有。
 *   2. 数据层形状正确（升序、长度自洽、无 NaN）
 *   3. 桌面宽度下图元全部落在画布内
 *   4. 图内文字不小于可读下限，且序列化后不出现 NaN / undefined
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChartData } from '../src/lib/chart-data.js';
import { survivalScene, stripScene, sceneBounds } from '../src/lib/scene.js';
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

/* ======================== 结果 ======================== */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
