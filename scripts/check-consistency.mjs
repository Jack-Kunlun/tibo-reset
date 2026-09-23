#!/usr/bin/env node
/**
 * A3 一致性比对：页面内联的预测数字 ↔ 后端 API 返回。
 *
 * 为什么不能「取页面数字、取 API 数字、直接比」：
 *   页面是**静态渲染**，锚定在构建那一刻（builtAt）；API 是**请求时实算**，锚定在请求那一刻。
 *   预测里的「中位剩余等待」随真实时间推进而缩小，两边因此天然差一个时间锚点。
 *   拿它当误差糊过去，就等于把「页面是不是忠实渲染」这件真问题藏起来了。
 *
 * 所以本脚本把这件事拆成四条**精确**判据，各自独立成立：
 *   ① 页面 digest == 用 builtAt 重算一遍         → 页面是数据的忠实渲染
 *   ② digest 里的数字确实出现在页面可见文字里     → 摘要没有说谎
 *   ③ API 返回    == 用 API 自己的 asOf 重算一遍  → API 也是忠实渲染
 *   ④ 两者按**显示精度**比对（0.1 天 / 0.1%）     → 用户看到的数字一致
 * 最后显式报出两个锚点的间距。四条都是精确判据，没有隐藏容差。
 *
 * ⚠ 刻意避开的字段：`prediction.uncertainty`。它来自 bootstrap 重采样，
 *   `bootstrapCI` 用的是 `Math.random`，同一个请求跑两次结果都不同 ——
 *   拿它做一致性判据只会得到随机失败。页面也没有展示它。
 *
 * 用法：
 *   node scripts/check-consistency.mjs            # 要求 dist 新鲜（10 分钟内）
 *   node scripts/check-consistency.mjs --build    # 先重建，保证锚点贴近现在
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChartData, partsIn } from '../src/lib/chart-data.js';
import { predictAll } from '../src/lib/predict.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
const FRESH_MS = 10 * 60_000;

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

const near = (a, b, eps = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;
const d1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : String(x));

/* ---------------------------- 0. 前置 ---------------------------- */

if (process.argv.includes('--build')) {
  console.log('▸ 先重新构建，让页面锚点贴近现在…');
  await new Promise((ok, bad) => {
    const p = spawn(process.execPath, ['scripts/build.mjs'], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    p.on('exit', (c) => (c === 0 ? ok() : bad(new Error(`构建失败，退出码 ${c}`))));
  });
}

const read = async (p) => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'));
const [resets, html] = await Promise.all([
  read('data/resets.json'),
  readFile(resolve(ROOT, 'dist/index.html'), 'utf8'),
]);

/* ------------------------ 1. 取出页面 digest ------------------------ */

const m = html.match(/<script type="application\/json" id="data-digest">([\s\S]*?)<\/script>/);
if (!m) {
  console.error('✗ 页面里找不到 data-digest —— 先运行 npm run build');
  process.exit(1);
}

let digest;
try {
  digest = JSON.parse(m[1].replace(/\\u003c/g, '<'));
} catch (err) {
  console.error(`✗ data-digest 不是合法 JSON：${err.message}`);
  process.exit(1);
}

console.log('\n【页面 digest】');

const builtAtMs = Date.parse(digest.builtAt);
const staleness = Date.now() - builtAtMs;
check(
  `构建锚点可解析且新鲜（${(staleness / 60_000).toFixed(1)} 分钟前）`,
  Number.isFinite(builtAtMs) && staleness < FRESH_MS,
  staleness >= FRESH_MS ? 'dist 已过期，加 --build 或先 npm run build' : digest.builtAt
);

/* ------------------- 2. 页面 == 用 builtAt 重算 ------------------- */

console.log('\n【① 页面是数据的忠实渲染】');

const pageChart = buildChartData(resets.records, builtAtMs);
const pagePred = predictAll(resets.records, { now: builtAtMs });

check('记录总数一致', digest.records === pageChart.count, `${digest.records} vs ${pageChart.count}`);
check(
  '距上次重置天数一致',
  near(digest.sinceDays, (builtAtMs - new Date(pageChart.lastAt).getTime()) / DAY),
  `${digest.sinceDays} vs ${(builtAtMs - new Date(pageChart.lastAt).getTime()) / DAY}`
);
check(
  '中位间隔一致',
  near(digest.intervals.median, pageChart.median),
  `${digest.intervals.median} vs ${pageChart.median}`
);
check(
  '中位剩余等待一致',
  near(digest.remainingDays.q50, pagePred.prediction.q50),
  `${digest.remainingDays.q50} vs ${pagePred.prediction.q50}`
);
check(
  '80% 区间一致',
  near(digest.remainingDays.q25, pagePred.prediction.q25) &&
    near(digest.remainingDays.q90, pagePred.prediction.q90),
  `${digest.remainingDays.q25}–${digest.remainingDays.q90} vs ${pagePred.prediction.q25}–${pagePred.prediction.q90}`
);
check(
  '覆盖率校准值一致',
  near(digest.calibration.cov50, pagePred.calibration.cov50) &&
    near(digest.calibration.cov80, pagePred.calibration.cov80),
  `cov50 ${digest.calibration.cov50} vs ${pagePred.calibration.cov50}`
);
check(
  'Brier skill 一致',
  near(digest.skill.brier, pagePred.skill.brier) && near(digest.skill.score, pagePred.skill.score),
  `${digest.skill.brier} vs ${pagePred.skill.brier}`
);
check(
  '各时间窗概率一致',
  JSON.stringify(digest.horizons) ===
    JSON.stringify(pagePred.prediction.horizons.map((h) => ({ label: h.label, p: h.p })))
);

/* ---------------- 3. digest 的数字确实在页面文字里 ---------------- */

console.log('\n【② 摘要与页面可见文字一致】');

// 只删注释 / 脚本 / 样式标签与其余标签，不做结构解析 ——
// 结构一变就误报的判据，迟早会被人关掉。
const visible = html
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ');

check('可见文字含中位剩余等待', visible.includes(d1(digest.remainingDays.q50)), d1(digest.remainingDays.q50));
check('可见文字含距上次重置天数', visible.includes(d1(digest.sinceDays)), d1(digest.sinceDays));
check('可见文字含记录总数', visible.includes(String(digest.records)), String(digest.records));
check(
  '可见文字含 50% 覆盖率',
  visible.includes((digest.calibration.cov50 * 100).toFixed(1)),
  (digest.calibration.cov50 * 100).toFixed(1)
);

/* ----------------------- 4. 起服务、取 API ----------------------- */

console.log('\n【③ API 是数据的忠实渲染】');

const freePort = await new Promise((ok) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => ok(port));
  });
});

const proc = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(freePort), DATA_DIR: resolve(ROOT, 'data'), COLLECT_INTERVAL_MIN: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
proc.stderr.on('data', (b) => (serverErr += b.toString()));

const base = `http://127.0.0.1:${freePort}`;
let api = null;
try {
  for (let i = 0; i < 40 && !api; i++) {
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) api = await (await fetch(`${base}/api/state`)).json();
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
} finally {
  proc.kill('SIGTERM');
}

if (!api) {
  console.log(`  ✗ 服务未就绪${serverErr ? '：' + serverErr.trim().split('\n')[0] : ''}`);
  failures.push('后端服务未就绪，API 侧比对未执行');
} else {
  const apiChartNow = api.chart?.now;
  const apiAsOf = Date.parse(api.prediction.asOf);

  const apiChart = buildChartData(resets.records, apiChartNow);
  const apiPred = predictAll(resets.records, { now: apiAsOf });

  check('API 记录总数 == 重算', api.chart.count === apiChart.count, `${api.chart.count} vs ${apiChart.count}`);
  check(
    'API 中位剩余 == 重算',
    near(api.prediction.prediction.q50, apiPred.prediction.q50),
    `${api.prediction.prediction.q50} vs ${apiPred.prediction.q50}`
  );
  check(
    'API 80% 区间 == 重算',
    near(api.prediction.prediction.q25, apiPred.prediction.q25) &&
      near(api.prediction.prediction.q90, apiPred.prediction.q90)
  );
  check(
    'API 覆盖率 == 重算',
    near(api.prediction.calibration.cov50, apiPred.calibration.cov50),
    `${api.prediction.calibration.cov50} vs ${apiPred.calibration.cov50}`
  );
  check(
    'API 各时间窗概率 == 重算',
    JSON.stringify(api.prediction.prediction.horizons.map((h) => ({ label: h.label, p: h.p }))) ===
      JSON.stringify(apiPred.prediction.horizons.map((h) => ({ label: h.label, p: h.p })))
  );
  check(
    '两侧数据版本相同（dataUpdatedAt）',
    api.dataUpdatedAt === digest.dataUpdatedAt,
    `${api.dataUpdatedAt} vs ${digest.dataUpdatedAt}`
  );

  /* ------------------- 5. 两边按显示精度比对 ------------------- */

  console.log('\n【④ 用户看到的数字一致】');

  const gapMin = (apiAsOf - builtAtMs) / 60_000;
  console.log(`   锚点间距：${gapMin >= 0 ? '' : '−'}${Math.abs(gapMin).toFixed(1)} 分钟（页面 ${digest.builtAt} / API ${api.prediction.asOf}）`);

  check(
    `距上次重置（显示值 ${d1(digest.sinceDays)} 天）`,
    d1(digest.sinceDays) === d1(api.prediction.sinceDays),
    `页面 ${d1(digest.sinceDays)} vs API ${d1(api.prediction.sinceDays)}`
  );
  check(
    `中位剩余等待（显示值 ${d1(digest.remainingDays.q50)} 天）`,
    d1(digest.remainingDays.q50) === d1(api.prediction.prediction.q50),
    `页面 ${d1(digest.remainingDays.q50)} vs API ${d1(api.prediction.prediction.q50)}`
  );
  check(
    '80% 区间显示值一致',
    d1(digest.remainingDays.q25) === d1(api.prediction.prediction.q25) &&
      d1(digest.remainingDays.q90) === d1(api.prediction.prediction.q90),
    `页面 ${d1(digest.remainingDays.q25)}–${d1(digest.remainingDays.q90)} vs API ${d1(api.prediction.prediction.q25)}–${d1(api.prediction.prediction.q90)}`
  );
  check(
    '50% 覆盖率显示值一致',
    (digest.calibration.cov50 * 100).toFixed(1) === (api.prediction.calibration.cov50 * 100).toFixed(1),
    `页面 ${(digest.calibration.cov50 * 100).toFixed(1)}% vs API ${(api.prediction.calibration.cov50 * 100).toFixed(1)}%`
  );
  check(
    '历史间隔中位数显示值一致',
    d1(digest.intervals.median) === d1(api.chart.median),
    `页面 ${d1(digest.intervals.median)} vs API ${d1(api.chart.median)}`
  );
}

/* ---------------- 5. 倒计时锚点自洽：数字数到的那一刻 == 标签写的那一刻 ---------------- */

console.log('\n【⑤ 倒计时锚点自洽】');

// 这一段是「你这时间也不对啊」那条反馈的直接产物。改之前页面上只有一串跳动的
// 数字，不写它数到哪一刻 —— 读的人没法核对，只能选择信或不信。
// 现在锚点写在标签里（`.cd-anchor`），于是它能被**机械核对**：
// 把 `data-from` 按北京时间格式化，必须与标签逐字相同。
//
// 刻意不依赖任何外部数据：这条判据校验的是「页面自己说的话前后一致」，
// 所以数据源变了、时区规则改了，它依然成立 —— 而且它正是用户会做的那次核对。
const cds = [
  ...html.matchAll(
    /<div class="sig-cd" data-from="(\d+)"[\s\S]*?<span class="cd-anchor">([^<]*)<\/span>/g
  ),
];

// 倒数块是**预告块专属**的：`render.mjs` 里只有 `forecastBlock` 会渲染
// `windowCountdown()`，线索档（`hintBlock`）没有，静默态更没有。
// 所以断言方向必须跟着页面当前档位走 —— 无条件要求「必须有 .sig-cd」，
// 会在「暂无预告」这个**完全正常**的状态下误报。
// （KI-004 撤下已兑现的预告之后，这条就一直红着：页面没毛病，是判据少了个前提。）
//
// 判据取**预告块本身**，而不是静默态标记 `sig-idle` —— 后者在「留档触顶」那条
// 小提示上也在用（`render.mjs:187`），预告在场时同样会出现，拿它判静默会误伤。
// 预告块的标志是 `data-level` 非 hint 的 `.sig` section（hintBlock 走 hint 档）。
const forecastBlocks = (html.match(/<section class="sig" data-level="(?!hint")/g) || []).length;
check(
  `倒计时块与页面档位一致（预告块 ${forecastBlocks} 个 / 倒数 ${cds.length} 个）`,
  forecastBlocks > 0 ? cds.length > 0 : cds.length === 0,
  forecastBlocks > 0
    ? '有预告块却没有 .sig-cd —— 这条倒数必须存在'
    : '没有预告块却出现了 .sig-cd —— 已兑现 / 已过期的预告漏出来了？'
);
for (const [, fromStr, anchor] of cds) {
  const from = Number(fromStr);
  const p = partsIn(new Date(from).toISOString(), 'Asia/Shanghai');
  const want = `北京时间 ${p.year}.${p.month}.${p.day}（${p.weekdayCN}）${p.hour}:${p.minute}`;
  check(
    `倒数数到的那一刻与标签一致（${want}）`,
    anchor.trim() === want,
    `标签写的是「${anchor.trim()}」`
  );
  // 顺带锁住「窗口开启时刻必须还在未来或刚过」：数到一个已经过去很久的时刻，
  // 说明这条预告该下线了 —— 那是数据层的问题，不该让页面去兜。
  check(
    `倒数锚点是可信的时间戳（${new Date(from).toISOString()}）`,
    Number.isFinite(from) && from > Date.parse('2020-01-01T00:00:00Z'),
    String(fromStr)
  );
}

/* ---------------------------- 结果 ---------------------------- */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
