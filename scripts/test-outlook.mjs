#!/usr/bin/env node
/**
 * 预测总览（`src/lib/outlook.mjs`）与「这个预测凭什么可信」依据区的常驻断言。
 *
 * 为什么单独一个套件：依据区里的结语有**两支**，而公告支在当前数据上不可达
 * （采集结果里预告 0 条，`buildOutlook` 永远走 else）。不跑的代码等于没写，
 * 偏偏这一支的正确性全靠两件事，而两条都不是「看一眼就知道对」的：
 *
 *   ① 它必须**换一套判据** —— 公告档的依据是公告的明确程度，不是模型的统计表现。
 *      把推算支的三项（样本量 / 覆盖率 / 重采样波动）说成公告档的判断理由，
 *      等于拿 A 的理由解释 B 的结论。
 *   ② 两支的结语都必须**由判据算出来**。第一版写死了「三项都在容差内，所以给出
 *      「X」」，任何一项不达标的那天它就成了一句假话。
 *
 * 六节：
 *   1. 闸门（数据不足时返回 null，而不是画一张空卡）
 *   2. 推算支：ETA 与 80% 区间都取 [q10, q90]
 *   3. 公告支：三种粒度 → 三组 (status, confidence, reason)
 *   4. 依据区：两支的判据不得串味（含「不是恒真」的守卫 + 披露不得少）
 *   5. 结语与判据一致（含「不是恒真」的守卫）
 *   6. 公告支三档的结语必须各不相同
 *
 * ⚠ 断言必须在**主卡 + 依据区**的合并产物上跑（`pageOf`）：改版后「凭什么」那一层
 *   搬进了依据区三张卡，只渲染主卡等于测一个页面上不存在的东西。
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChartData } from '../src/lib/chart-data.js';
import { predictAll } from '../src/lib/predict.mjs';
import { buildOutlook, CONF_MIN_BACKTEST_N, CONF_MAX_MEDIAN_REL } from '../src/lib/outlook.mjs';
import { renderOutlook, renderBasis, renderBasisSummary } from '../src/lib/render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;

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

/* ------------------------------ 夹具 ------------------------------ */

const resets = JSON.parse(await readFile(resolve(ROOT, 'data/resets.json'), 'utf8'));

// ⚠ 锚点必须**由数据推导**，且必须**晚于最新记录**（同 `test-shared.mjs` 的理由）：
//   `sinceDays` 是「最新记录 → now」这段右删失区间的长度，now 早于最新记录会让它为负。
//   同时不能用 `Date.now()` —— 那样同一份数据在不同时刻跑出不同结果，失败无法复现。
const latestRecordMs = Math.max(
  ...resets.records.map((r) => new Date(r.announced_at).getTime()).filter((t) => Number.isFinite(t))
);
const NOW = latestRecordMs + 6 * 3_600_000;

const chart = buildChartData(resets.records, NOW);
const prediction = predictAll(resets.records, { now: NOW });

/** 一条公告的最小形状（`buildOutlook` 只读 window.fromTs / counts / precision / createdAt） */
const forecast = (over = {}) => ({
  window: { fromTs: NOW + 2 * DAY, toTs: NOW + 9 * DAY },
  createdAt: new Date(NOW - 6 * 3_600_000).toISOString(),
  precision: 'instant',
  counts: { hard: 1, soft: 0 },
  ...over,
});
const OUTLOOK_SIGNALS = { forecasts: [], checkedTweets: 307, counts: { hint: 44 } };
const outlookOf = (signals, pred = prediction) => buildOutlook({ chart, prediction: pred, signals, now: NOW });
/**
 * 主卡 + 依据区**一起**渲染。
 *
 * 为什么要两份合起来：结论的「依据」不在主卡里，而在依据区那三张卡上 ——
 * 卡②的结语是拿三项判据算出来的，卡①/卡③的结语各自讲自己的量。
 * 只渲染主卡就断言，等于测一个页面上不存在的东西（这正是改版后第一批断言
 * 全红的原因：它们盯着旧的侧卡，而侧卡已经并进依据区）。
 */
const pageOf = (o, signals = OUTLOOK_SIGNALS, pred = prediction) =>
  renderOutlook(o, chart, pred, signals, null) + renderBasis(o, chart, pred, signals);

/* ======================== 1. 闸门 ======================== */

section('1. 闸门：数据不足时返回 null，而不是画一张空卡');

// ⚠ 这一条必须直接调 `buildOutlook`，不能借 `outlookOf` —— 后者的 `chart` 是闭包里
//   那个真 chart，传不了 null，用例会恒绿（第一版就是这么写的）。
check(
  '没有 chart → null',
  buildOutlook({ chart: null, prediction, signals: OUTLOOK_SIGNALS, now: NOW }) === null
);
check(
  'prediction 里没有 q50 → null',
  buildOutlook({ chart, prediction: {}, signals: OUTLOOK_SIGNALS, now: NOW }) === null
);
check('正常输入 → 有结果', outlookOf(OUTLOOK_SIGNALS) !== null);

/* ======================== 2. 推算支 ======================== */

section('2. 推算支：ETA 与 80% 区间都取 [q10, q90]');

const oModel = outlookOf(OUTLOOK_SIGNALS);
const p = prediction.prediction;

check('无公告时 etaKind = model', oModel.etaKind === 'model');
check('无公告时 status = watching（观察中）', oModel.status === 'watching');
check(
  'etaAt = round(now + q50 天)',
  oModel.etaAt === Math.round(NOW + p.q50 * DAY),
  `etaAt=${oModel.etaAt} 期望 ${Math.round(NOW + p.q50 * DAY)}`
);
check(
  '80% 区间两端 = now + q10/q90（**不是** q25）',
  oModel.band.fromAt === NOW + p.q10 * DAY && oModel.band.toAt === NOW + p.q90 * DAY,
  `band=[${oModel.band.fromAt}, ${oModel.band.toAt}]`
);
check('q10 与 q25 确实是两个不同的端点', p.q10 !== p.q25, `q10=${p.q10} q25=${p.q25}`);
check('区间左端不晚于右端', oModel.band.fromAt < oModel.band.toAt);
check('推算支的置信度上限是「中」（没有承诺就没有「高」）', oModel.confidence !== 'high');

/* ======================== 3. 公告支的三种粒度 ======================== */

section('3. 公告支：三种粒度 → 三组 (status, confidence, reason)');

const annCases = [
  ['说死到具体时刻', { precision: 'instant', counts: { hard: 1, soft: 0 } }, 'confirmed', 'high', 'hard-date'],
  ['只到「一周内」', { precision: 'week', counts: { hard: 1, soft: 2 } }, 'likely', 'medium', 'hard-vague'],
  ['只有模糊表述', { precision: 'soft', counts: { hard: 0, soft: 3 } }, 'likely', 'medium', 'soft-only'],
];
const annOutlooks = {};
for (const [label, f, status, level, reason] of annCases) {
  const o = outlookOf({ ...OUTLOOK_SIGNALS, forecasts: [forecast(f)] });
  annOutlooks[reason] = o;
  check(
    `${label} → ${status} / ${level} / ${reason}`,
    o.etaKind === 'announced' && o.status === status && o.confidence === level && o.confidenceReason === reason,
    `实得 ${o.etaKind} / ${o.status} / ${o.confidence} / ${o.confidenceReason}`
  );
}

const oAnn = annOutlooks['hard-date'];
check('公告支的 ETA 取窗口开启时刻', oAnn.etaAt === NOW + 2 * DAY, `etaAt=${oAnn.etaAt}`);
check('公告支的区间就是公告窗口本身', oAnn.band.fromAt === NOW + 2 * DAY && oAnn.band.toAt === NOW + 9 * DAY);
check('主卡把公告窗口与模型 80% 区间区分开', renderOutlook(oAnn).includes('公告窗口') && !renderOutlook(oAnn).includes('80% 预测区间') && renderOutlook(oModel).includes('80% 预测区间'));
check('公告主卡保留明确时刻，不能只有日期', /\d{2}:\d{2} 公告窗口开启时刻/.test(renderOutlook(oAnn)));
check('软公告依据摘要显示同日提及数，不虚构硬承诺', renderBasisSummary(annOutlooks['soft-only'], prediction).includes('3<small>条同日提及') && !renderBasisSummary(annOutlooks['soft-only'], prediction).includes('条承诺'));
check('推算依据摘要保留真实样本量和回测覆盖率', renderBasisSummary(oModel, prediction).includes(`${oModel.brief.intervals}<small>次间隔`) && renderBasisSummary(oModel, prediction).includes((prediction.calibration.covBand80 * 100).toFixed(1)));
// 依据的**边界披露**必须有**可见**落点（`.am-basis-note`），且两支分工不同：
// 推算档报「扫了多少条、一条都没采信」，公告档声明「依据来自公告本身」。
// ⚠ 这两条与主卡那句 `pc-brief` 是**同一件事的两个家**：元素若被改回 `am-sr-only`
//   或文字被清空，主卡的读屏句仍会命中，只看主卡发现不了 —— 所以判据必须落在
//   `am-basis-note` 这个**元素名**上，而不是那句文字本身。
const modelSummary = renderBasisSummary(oModel, prediction);
check(
  '推算依据摘要有可见披露：报出扫描条数与线索数',
  modelSummary.includes('class="am-basis-note"') && modelSummary.includes(`${oModel.brief.scanned} 条推文`) && modelSummary.includes(`${oModel.brief.hints} 条时间线索`),
  modelSummary.includes('class="am-basis-note"') ? '有元素但文字不符' : '缺 .am-basis-note'
);
const annSummary = renderBasisSummary(oAnn, prediction);
check(
  '公告依据摘要的可见披露换成「依据来自公告本身」，不报扫描',
  annSummary.includes('class="am-basis-note"') && annSummary.includes('依据来自公告本身') && !annSummary.includes('条推文'),
  `元素=${annSummary.includes('class="am-basis-note"')} 公告句=${annSummary.includes('依据来自公告本身')} 扫描=${annSummary.includes('条推文')}`
);

/* ======================== 4. 两支的依据不得串味 ======================== */

section('4. 依据区：两支的判据不得串味');

// 「串味」长什么样：公告档下把**模型的统计表现**说成结论的理由。
// 那等于拿 A 的理由解释 B 的结论 —— 公告档的结论来自公告（他把话说死到几点），
// 统计三项只是同时要披露的数字。
//
// 判据落在两处（`pc-brief` 一句话摘要 / 依据卡②的结语），因为这两处正是
// 页面**陈述依据**的地方。模型的四项统计在**两支里都要出现**（AGENTS.md 文案
// 红线第 3 条：覆盖率、区分度、样本量是必须留的数字），所以不能拿「有没有这些
// 数字」当判据 —— 判据只能是「有没有把它们说成理由」。
const ANN_NOTE = '依据来自公告本身';
const MODEL_NOTE = '都在容差内';
const FAIL_NOTE = '项未达标';
const MODEL_BRIEF = '历史间隔的节奏推算';
const ANN_BRIEF = '已给出公告';

const annHtml = pageOf(oAnn, { ...OUTLOOK_SIGNALS, forecasts: [forecast()] });
const modelHtml = pageOf(oModel);

check(
  '公告支的摘要说的是「公告」，不说「按历史节奏推算」',
  annHtml.includes(ANN_BRIEF) && !annHtml.includes(MODEL_BRIEF),
  `含公告=${annHtml.includes(ANN_BRIEF)} 含节奏推算=${annHtml.includes(MODEL_BRIEF)}`
);
check(
  '推算支的摘要说的是「按历史节奏推算」，不说「已给出公告」',
  modelHtml.includes(MODEL_BRIEF) && !modelHtml.includes(ANN_BRIEF)
);
check(
  '公告支的回测卡结语声明依据来自公告，不搬三项统计',
  annHtml.includes(ANN_NOTE) && !annHtml.includes(MODEL_NOTE) && !annHtml.includes(FAIL_NOTE),
  `公告本身=${annHtml.includes(ANN_NOTE)} 容差句=${annHtml.includes(MODEL_NOTE)}`
);
// 非恒真守卫：同一套「结语在讲什么」的判据，在推算支下必须命中相反的那一句。
// 否则上面那条可能是因为结语整个没渲染（字符串压根不在页面里）而恒真。
check(
  '同一套判据在推算支下命中的是统计那句（证明上一条不是恒真）',
  modelHtml.includes(MODEL_NOTE) && !modelHtml.includes(ANN_NOTE),
  `容差句=${modelHtml.includes(MODEL_NOTE)} 公告句=${modelHtml.includes(ANN_NOTE)}`
);
// 数据披露本身两支都不能少：四项统计是必须留的数字。
for (const [name, html] of [['公告支', annHtml], ['推算支', modelHtml]]) {
  const rows = ['50% 分位覆盖率', '80% 区间覆盖率', '7 天区分度', '重采样波动'];
  const miss = rows.filter((s) => !html.includes(s));
  check(`${name}的回测卡仍有四项统计数字`, miss.length === 0, miss.length ? `缺：${miss.join('、')}` : '四项都在');
}

/* ======================== 5. 结语与判据一致 ======================== */

section('5. 结语必须由判据算出来，不能写死');

const ALL_OK = MODEL_NOTE;
const SOME_FAIL = FAIL_NOTE;

check('推算支三项全达标时，结语说「都在容差内」', modelHtml.includes(ALL_OK));
check('推算支三项全达标时，结语不含「未达标」', !modelHtml.includes(SOME_FAIL));

// 逼 relOk 失败：把重采样区间撑宽到 (hi − lo) / mid > CONF_MAX_MEDIAN_REL
const wide = {
  ...prediction,
  uncertainty: { ...prediction.uncertainty, medianDays: { lo: 1, mid: 10, hi: 30 } },
};
check(
  `造出来的输入确实踩在 rel 阈值之外（rel = ${(30 - 1) / 10} > ${CONF_MAX_MEDIAN_REL}）`,
  (30 - 1) / 10 > CONF_MAX_MEDIAN_REL
);
const oWide = outlookOf(OUTLOOK_SIGNALS, wide);
const wideHtml = pageOf(oWide, OUTLOOK_SIGNALS, wide);
check('重采样范围超限时，置信度降为「低」', oWide.confidence === 'low', `实得 ${oWide.confidence}`);
check(
  `重采样范围超限时，结语改口为「${SOME_FAIL}」`,
  wideHtml.includes(SOME_FAIL) && !wideHtml.includes(ALL_OK),
  `含「${SOME_FAIL}」=${wideHtml.includes(SOME_FAIL)} 含「${ALL_OK}」=${wideHtml.includes(ALL_OK)}`
);

// 逼 nOk 失败：样本量降到阈值以下
const few = { ...prediction, calibration: { ...prediction.calibration, n: CONF_MIN_BACKTEST_N - 1 } };
const oFew = outlookOf(OUTLOOK_SIGNALS, few);
const fewHtml = pageOf(oFew, OUTLOOK_SIGNALS, few);
check(
  `样本量降到 ${CONF_MIN_BACKTEST_N - 1} 时该项未达标、结语改口`,
  oFew.confidence === 'low' && fewHtml.includes(SOME_FAIL) && !fewHtml.includes(ALL_OK)
);

// 非恒真守卫：两句话在两种输入下各出现一次 —— 说明「结语随判据走」这条断言
// 不是恒真（若哪天结语被写死，上面两条里必然有一条会红）。
check(
  '结语在两种输入下给出不同句子（证明「随判据走」这条断言不是恒真）',
  modelHtml.includes(ALL_OK) && wideHtml.includes(SOME_FAIL)
);

/* ======================== 6. 公告支三档的结语各不相同 ======================== */

section('6. 公告支三档的结语各不相同');

// 依据卡②的结语带一个显式钩子（`data-note="backtest"`）—— 页面上有三条 `.bc-note`，
// 按 class 取会取到卡①那条。钩子是给测试用的稳定锚点，不是样式钩子。
const noteOf = (html) =>
  (html.match(/<p class="bc-note" data-note="backtest">([\s\S]*?)<\/p>/) ?? [, ''])[1].trim();
const notes = {
  'hard-date': noteOf(pageOf(annOutlooks['hard-date'], { ...OUTLOOK_SIGNALS, forecasts: [forecast()] })),
  'hard-vague': noteOf(
    pageOf(annOutlooks['hard-vague'], {
      ...OUTLOOK_SIGNALS,
      forecasts: [forecast({ precision: 'week', counts: { hard: 1, soft: 2 } })],
    })
  ),
  'soft-only': noteOf(
    pageOf(annOutlooks['soft-only'], {
      ...OUTLOOK_SIGNALS,
      forecasts: [forecast({ precision: 'soft', counts: { hard: 0, soft: 3 } })],
    })
  ),
};
check('三档结语都非空', Object.values(notes).every((s) => s.length > 0), JSON.stringify(notes));
check('三档结语互不相同', new Set(Object.values(notes)).size === 3, JSON.stringify(notes, null, 1));
check(
  'high 那一档说清了「依据来自公告、与模型统计无关」',
  /公告本身/.test(notes['hard-date']) && /模型统计/.test(notes['hard-date']),
  notes['hard-date']
);
check('三档结语都不含推算支的那句话', Object.values(notes).every((s) => !s.includes(ALL_OK)));

/* ======================== 7. 重采样必须可复现 ======================== */

section('7. 重采样必须可复现（页面上展示的那个区间是它的产物）');

// 侧卡的「中位估计的重采样范围」直接来自 `bootstrapCI`，而生产入口是**按请求实时渲染**
// 的 —— 未播种的随机流会让同一个用户每刷新一次页面这个区间就跳一次。
//
// ⚠ 这一条**不能**指望 A8 代劳。A8 比的是页面字节，而展示已取整到天，跨种子的抖动
//   （实测 lo 端点 17.88–18.04 天）小于一天的取整粒度 —— 于是未播种时同一份数据
//   照样输出同一行「约 18 – 20 天」，A8 全绿而数字其实每次都在动。
//   所以这里直接断言**值**：字符串看不出来的抖动，只有原始值看得见。
const u1 = predictAll(resets.records, { now: NOW }).uncertainty;
const u2 = predictAll(resets.records, { now: NOW }).uncertainty;
check(
  '两次 predictAll 的 uncertainty 逐字节相同（bootstrap 已固定种子）',
  JSON.stringify(u1) === JSON.stringify(u2),
  `medianDays: ${JSON.stringify(u1.medianDays)} vs ${JSON.stringify(u2.medianDays)}`
);
check(
  'medianDays 三个端点都是有限数（不是靠 undefined 相等蒙过去的）',
  [u1.medianDays.lo, u1.medianDays.mid, u1.medianDays.hi].every((v) => Number.isFinite(v)),
  JSON.stringify(u1.medianDays)
);
// 非恒真守卫：把种子换成「每次调用都新建一个随机流」的形态，值必然不同 ——
// 证明上一条断言真的在测「确定性」，而不是因为两边本来就是同一份缓存对象。
const seeded = predictAll(resets.records, { now: NOW, rng: (() => (n => () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x80000000))(1))() });
check(
  '换一条随机流，值确实会变（证明上一条不是在测同一个对象）',
  JSON.stringify(seeded.uncertainty.medianDays) !== JSON.stringify(u1.medianDays),
  `换流后 ${JSON.stringify(seeded.uncertainty.medianDays)}`
);

/* ======================== 结果 ======================== */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
