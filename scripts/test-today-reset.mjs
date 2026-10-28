#!/usr/bin/env node
/** 今日到账状态的共享判据、网页输出与小程序展示回归。 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

import { buildTodayReset, buildOutlook } from '../src/lib/outlook.mjs';
import { derive, renderPage } from '../src/lib/page.mjs';
import { buildProgramPlanView, buildTodayResetView } from '../miniprogram/utils/view.js';
import { buildChartData } from '../src/lib/chart-data.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-26T04:15:00.000Z'); // 北京 12:15
const ARRIVED_AT = Date.parse('2026-10-26T03:07:00.000Z'); // 北京 11:07
const YESTERDAY = Date.parse('2026-10-25T15:59:00.000Z');
const iso = (ts) => new Date(ts).toISOString();

let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sourcePath = resolve(ROOT, 'src/lib/outlook.mjs');
const sourceBefore = await readFile(sourcePath);
const sourceHashBefore = createHash('sha256').update(sourceBefore).digest('hex');
const dashboardPath = resolve(ROOT, 'miniprogram/utils/dashboard.js');
const dashboardSourceBefore = await readFile(dashboardPath);
const dashboardHashBefore = createHash('sha256').update(dashboardSourceBefore).digest('hex');

console.log('\n【1】今日到账判据：只读真实记录时间，按北京时间定日');
const today = buildTodayReset({ lastAt: iso(ARRIVED_AT) }, NOW);
check('同一北京时间日期返回到账时刻与日期标签', today?.at === ARRIVED_AT && today.dayKey === '2026-10-26' && today.dayLabel === '10.26 周一');
check('同日多笔记录由 chart.lastAt 指向最新一笔', buildTodayReset({ lastAt: ARRIVED_AT + 23 * 60_000 }, NOW)?.at === ARRIVED_AT + 23 * 60_000);
check('普通重置类型可进入相同今日判据', buildTodayReset(buildChartData([
  { announced_at: iso(YESTERDAY - DAY), type: 'reset' },
  { announced_at: iso(ARRIVED_AT), type: 'reset' },
], NOW), NOW)?.at === ARRIVED_AT);
check('发券型 credit 也作为已到账事件', buildTodayReset(buildChartData([
  { announced_at: iso(YESTERDAY - DAY), type: 'reset' },
  { announced_at: iso(ARRIVED_AT), type: 'credit' },
], NOW), NOW)?.at === ARRIVED_AT);
check('昨天的记录不显示为今日到账', buildTodayReset({ lastAt: iso(YESTERDAY) }, NOW) === null);
check('明天的记录不显示，且未来时刻不会被当成已到账', buildTodayReset({ lastAt: iso(NOW + 1) }, NOW) === null);
check('北京时间跨午夜后，午夜前的记录不再属于今天', buildTodayReset({ lastAt: '2026-10-25T15:59:00.000Z' }, Date.parse('2026-10-25T16:01:00.000Z')) === null);
check('缺少或非法的图表时刻返回空', buildTodayReset(null, NOW) === null && buildTodayReset({ lastAt: 'bad-time' }, NOW) === null);
check('非法 now 不会借用系统当前时刻', buildTodayReset({ lastAt: iso(ARRIVED_AT) }, NaN) === null);

const previousTZ = process.env.TZ;
try {
  process.env.TZ = 'America/Los_Angeles';
  check('切换系统时区仍按北京时间归日', buildTodayReset({ lastAt: iso(ARRIVED_AT) }, NOW)?.dayKey === '2026-10-26');
} finally {
  if (previousTZ === undefined) delete process.env.TZ;
  else process.env.TZ = previousTZ;
}

console.log('\n【2】预告与今日到账并存，预测不参与到账判定');
const prediction = {
  prediction: { q10: 1, q50: 2, q90: 4 },
  uncertainty: { medianDays: { lo: 1, mid: 2, hi: 3 } },
  calibration: { n: 40, covBand80: 0.8, cov50: 0.5, cov80: 0.8, cov90: 0.9 },
  skill: { score: 0.1 },
  model: { nIntervals: 5 },
};
const forecast = {
  level: 'explicit', timing: 'dated', precision: 'instant',
  counts: { hard: 1, soft: 0 }, text: 'Reset tomorrow morning.',
  url: 'https://x.com/thsottiaux/status/123', createdAt: iso(NOW - 60_000),
  window: { fromTs: NOW + 60 * 60_000, toTs: NOW + 60 * 60_000, deadline: false },
};
const predicted = buildOutlook({
  chart: { lastAt: iso(ARRIVED_AT), median: 8, sinceDays: 0.1, pct: 0.2 },
  prediction,
  signals: { forecasts: [forecast], checkedTweets: 1, counts: { hint: 0 } },
  now: NOW,
});
check('实际到账和未来预告同时保留', predicted.todayReset?.at === ARRIVED_AT && predicted.announcement?.text === forecast.text && predicted.etaKind === 'announced');
const forecastOnly = buildOutlook({
  chart: { lastAt: iso(YESTERDAY), median: 8, sinceDays: 1, pct: 0.2 },
  prediction,
  signals: { forecasts: [forecast], checkedTweets: 1, counts: { hint: 0 } },
  now: NOW,
});
check('只有预测预告时没有到账状态', forecastOnly.todayReset === null && forecastOnly.announcement?.text === forecast.text);

console.log('\n【3】网页真实页面输出');
const [resets, tweets, statsFile, template, renderSource] = await Promise.all([
  readFile(resolve(ROOT, 'data/resets.json'), 'utf8').then(JSON.parse),
  readFile(resolve(ROOT, 'data/tweets.json'), 'utf8').then(JSON.parse),
  readFile(resolve(ROOT, 'data/stats.json'), 'utf8').then(JSON.parse),
  readFile(resolve(ROOT, 'src/index.html'), 'utf8'),
  readFile(resolve(ROOT, 'src/lib/render.mjs'), 'utf8'),
]);
const latestResetMs = Math.max(...resets.records.map((row) => Date.parse(row.announced_at)).filter(Number.isFinite));
const baseNow = latestResetMs + 6 * 60 * 60_000;
const derived = derive({ resets, tweets, statsFile, now: baseNow, account: 'thsottiaux' });
const pageSignals = {
  ...derived.signals,
  forecasts: [forecast],
  generatedAt: iso(NOW),
};
const model = { ...derived.model, now: NOW, lastAt: iso(ARRIVED_AT) };
const html = renderPage({
  template, model, prediction: derived.prediction, signals: pageSignals,
  og: null, collect: { errors: [] }, logoUri: '',
});
check('renderPage 输出醒目的今日到账和北京时间', html.includes('今日重置已到账') && html.includes('11:07 北京时间'));
check('今日到账条与新的公开预告同时进入首页', html.indexOf('id="today-reset"') >= 0 && html.indexOf('id="today-reset"') < html.indexOf('class="am-signal-details') && html.includes('class="pcard is-announced"'));
check('模板中的状态条位于信号栏，并可随预测卡独立存在', /class="am-signal-slot">[\s\S]*?<!--__TODAY_RESET__-->[\s\S]*?<!--__SIGNAL__-->/.test(template) && renderSource.includes('TODAY_RESET: renderTodayReset(todayReset)'));
check('页面脚本在北京时间跨日时隐藏缓存的前一日提示', /todayReset\.dataset\.day !== new Date\(now \+ 8 \* 3600000\)/.test(template));

console.log('\n【4】小程序真实视图、午夜刷新与28天计划旧数据');
const tempRoot = await mkdtemp(resolve(tmpdir(), 'tibo-today-reset-'));
try {
  const formatSource = await readFile(resolve(ROOT, 'miniprogram/utils/format.js'), 'utf8');
  const viewSource = await readFile(resolve(ROOT, 'miniprogram/utils/view.js'), 'utf8');
  const miniViewSource = viewSource
    .replace("from './format.js'", "from './format.mjs'")
    .replace("from './outlook.js'", `from '${pathToFileURL(sourcePath).href}'`);
  await writeFile(resolve(tempRoot, 'format.mjs'), formatSource);
  await writeFile(resolve(tempRoot, 'view.mjs'), miniViewSource);
  const viewPath = resolve(tempRoot, 'view.mjs');
  const tempViewUrl = pathToFileURL(viewPath).href;
  const { buildOutlookView, buildProgramPlanView, buildTodayResetView } = await import(`${tempViewUrl}?today=${Date.now()}`);
  const todayView = buildTodayResetView({ lastAt: iso(ARRIVED_AT) }, NOW);
  const miniPrediction = buildOutlookView({ lastAt: iso(ARRIVED_AT), median: 8, sinceDays: 0.1, pct: 0.2 }, prediction, { forecasts: [forecast] }, NOW);
  check('小程序独立视图按当前日期输出今日到账时间', todayView?.time === '11:07' && todayView.dayLabel === '10.26 周一');
  check('小程序今日到账可与未来预告并列且不挂在预测对象上', todayView?.at === ARRIVED_AT && miniPrediction?.announcement?.text === forecast.text && !Object.hasOwn(miniPrediction || {}, 'todayReset'));
  check('小程序旧快照仅有昨日记录时不产生今日状态', buildTodayResetView({ lastAt: iso(YESTERDAY) }, NOW) === null);
  const noted = buildProgramPlanView({ days: 28, latestDay: 1, rows: [{ day: 1, status: 'noted', statusLabel: '当日动态', entries: [{ kind: 'note' }] }] }).days[0];
  const resetMention = buildProgramPlanView({ days: 28, latestDay: 1, rows: [{ day: 1, status: 'noted', statusLabel: '当日动态', entries: [{ kind: 'reset-unconfirmed' }] }] }).days[0];
  check('普通当日动态不冒充预告，按新口径归入 missing 显示短横线', noted.marker === '-' && noted.status === 'missing' && !noted.statusLabel.includes('预告'));
  check('旧“提及重置”账目改显示预告标记与待落地状态', resetMention.marker === '预' && resetMention.statusClass === 'pending' && resetMention.statusLabel === '重置预告·待落地');

  const wxml = await readFile(resolve(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8');
  const wxss = await readFile(resolve(ROOT, 'miniprogram/pages/index/index.wxss'), 'utf8');
  const indexPath = resolve(ROOT, 'miniprogram/pages/index/index.js');
  check('小程序状态条直接读取独立今日到账字段', wxml.includes('今日重置已到账') && wxml.includes('todayReset.dayLabel === todayLabel') && wxml.includes('{{todayReset.time}} 北京时间') && !wxml.includes('pred.todayReset'));
  check('320px 及窄屏布局可换行且复用到账绿，不添加新卡片阴影', wxss.includes('flex-wrap:wrap') && wxss.includes('@media (max-width: 360px)') && wxss.includes('#8de4c9') && !/tr-today-reset[^}]*box-shadow/.test(wxss));

  let pageConfig = null;
  globalThis.Page = (config) => { pageConfig = config; };
  await import(`${pathToFileURL(indexPath).href}?today-reset=${Date.now()}`);
  const context = {
    data: { todayLabel: '10.25 周日', degraded: true, pageVisible: false },
    setData(patch) { Object.assign(this.data, patch); },
    tickPredCountdown() { return null; },
    lastAt: null,
  };
  const savedNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-10-25T16:01:00.000Z');
    pageConfig.tick.call(context);
  } finally {
    Date.now = savedNow;
  }
  check('小程序现有秒级 ticker 在北京时间午夜更新今日标签', context.data.todayLabel === '10.26 周一');

  console.log('\n【4b】dashboard 当前时间接线：不受旧预测锚点或无预测状态阻断');
  const dashboardSource = dashboardSourceBefore.toString('utf8');
  const importsForTemp = (source) => source.replace(/from '([^']+)'/g, (_match, specifier) => {
    const target = specifier === './view.js' ? tempViewUrl : pathToFileURL(resolve(dirname(dashboardPath), specifier)).href;
    return `from '${target}'`;
  });
  const dashboardFixture = (predictionValue) => ({
    chart: {
      lastAt: iso(ARRIVED_AT), firstAt: iso(YESTERDAY - DAY),
      mean: 8, median: 8, longest: 12, count: 4, creditCount: 1,
      sinceDays: 0.1, pct: 0.2, gapDays: [], records: [], hist: { total: 0 },
    },
    prediction: predictionValue,
    signals: { forecasts: [], observedForecasts: [], overdueForecasts: [], activeHints: [], checkedTweets: 0, counts: { hint: 0 } },
    generatedAt: iso(YESTERDAY), dataUpdatedAt: iso(YESTERDAY), account: 'thsottiaux',
  });
  const createDashboardFixture = async (source, filename) => {
    const file = resolve(tempRoot, filename);
    await writeFile(file, importsForTemp(source));
    const mod = await import(`${pathToFileURL(file).href}?case=${filename}`);
    const page = mod.createDashboardPage('observe');
    page.data = { ...page.data };
    page.setData = (patch, callback) => {
      for (const [key, value] of Object.entries(patch)) {
        const path = key.split('.');
        let target = page.data;
        for (const segment of path.slice(0, -1)) {
          if (!target[segment] || typeof target[segment] !== 'object') target[segment] = {};
          target = target[segment];
        }
        target[path[path.length - 1]] = value;
      }
      if (callback) callback();
    };
    return page;
  };
  const stalePred = {
    ...prediction,
    asOf: iso(YESTERDAY),
    prediction: { ...prediction.prediction, horizons: [] },
    skill: { ...prediction.skill, brier: 0.1, baseline: 0.1 },
    phases: [],
  };
  const dashboard = await createDashboardFixture(dashboardSource, 'dashboard.mjs');
  const savedDateNow = Date.now;
  try {
    Date.now = () => NOW;
    dashboard.apply({ state: dashboardFixture(stalePred), degraded: true });
    check('asOf 昨日的预测不阻止 chart 今日到账显示', dashboard.data.todayReset?.at === ARRIVED_AT && dashboard.data.pred?.updatedText?.includes('10.25'));

    const noPredictionDashboard = await createDashboardFixture(dashboardSource, 'dashboard-no-prediction.mjs');
    noPredictionDashboard.apply({ state: dashboardFixture(null), degraded: true });
    check('没有预测对象时仍显示真实今日到账', noPredictionDashboard.data.pred === null && noPredictionDashboard.data.todayReset?.at === ARRIVED_AT);

    Date.now = () => Date.parse('2026-10-26T16:01:00.000Z');
    dashboard.tick();
    check('秒级 dashboard tick 在北京时间跨日后清除到账提示并更新日期', dashboard.data.todayReset === null && dashboard.data.todayLabel === '10.27 周二');
  } finally {
    Date.now = savedDateNow;
  }

  const mutantAnchor = 'buildTodayResetView(chart, currentNow)';
  const mutantSource = dashboardSource.replace(mutantAnchor, 'buildTodayResetView(chart, predNow)');
  check('dashboard 旧预测锚点变异锚点存在', mutantSource !== dashboardSource);
  const mutantDashboard = await createDashboardFixture(mutantSource, 'dashboard-mutant.mjs');
  const controlDashboard = await createDashboardFixture(dashboardSource, 'dashboard-control.mjs');
  // apply 的 setData 回调会立刻 tick；这里暂时禁用实例 ticker，才能单独观察 apply 锚点变异。
  mutantDashboard.tick = () => {};
  controlDashboard.tick = () => {};
  const mutantDateNow = Date.now;
  try {
    Date.now = () => NOW;
    controlDashboard.apply({ state: dashboardFixture(stalePred), degraded: true });
    mutantDashboard.apply({ state: dashboardFixture(stalePred), degraded: true });
    check('行为反例能抓住今日到账误用旧 prediction.asOf', controlDashboard.data.todayReset?.at === ARRIVED_AT && mutantDashboard.data.todayReset === null);
  } finally {
    Date.now = mutantDateNow;
  }
} finally {
  delete globalThis.Page;
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('\n【5】旧“提”展示回归与源码完整性');
const planSource = await readFile(resolve(ROOT, 'src/lib/render.mjs'), 'utf8');
const plan = { days: 1, latestDay: 1, rows: [{ day: 1, status: 'noted', statusLabel: '当日动态', entries: [{ kind: 'reset-unconfirmed' }] }] };
const { renderProgramPlan } = await import('../src/lib/render.mjs');
const legacyPlanHtml = renderProgramPlan(plan, null);
check('网页旧重置提及映射为预告，普通note仍保持当日动态', legacyPlanHtml.includes('plan-pending') && legacyPlanHtml.includes('重置预告·待落地') && !legacyPlanHtml.includes('提及重置'));
check('网页普通note归入 missing 标短横线，不标“提”', planSource.includes("'noted' || !markers[row.status] ? 'missing'") && !legacyPlanHtml.includes('<i aria-hidden="true">提</i>'));

// 反例变异只改内存中的模块文本：若未来时刻过滤丢失，下面的断言应能抓住。
const futureGuard = 'if (!finite(now) || !finite(lastAt) || lastAt > now) return null;';
const mutantSource = sourceBefore.toString('utf8').replace(futureGuard, 'if (!finite(now) || !finite(lastAt)) return null;');
check('未来时刻过滤的变异锚点存在', mutantSource !== sourceBefore.toString('utf8'));
const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString('base64')}`);
check('行为回归能抓住移除“未来到账”过滤的变异',
  buildTodayReset({ lastAt: iso(NOW + 1) }, NOW) === null && mutant.buildTodayReset({ lastAt: iso(NOW + 1) }, NOW) !== null);
const sourceAfter = await readFile(sourcePath);
check('变异过程未改写源文件（SHA-256 不变）', createHash('sha256').update(sourceAfter).digest('hex') === sourceHashBefore);
const dashboardAfter = await readFile(dashboardPath);
check('dashboard 变异过程未改写源文件（SHA-256 不变）', createHash('sha256').update(dashboardAfter).digest('hex') === dashboardHashBefore);

console.log(`\n源 SHA-256: ${sourceHashBefore}`);
console.log(`dashboard SHA-256: ${dashboardHashBefore}`);
console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const failure of failures) console.log(`   · ${failure}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
