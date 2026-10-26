#!/usr/bin/env node
/** 单账号到账观察在网页、小程序、28 天计划和日历中的呈现边界。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildChartData } from '../src/lib/chart-data.js';
import { predictAll } from '../src/lib/predict.mjs';
import { detectSignals } from '../src/lib/signals.mjs';
import { renderAll, renderProgramPlan, renderResetCalendar, renderSignal } from '../src/lib/render.mjs';
import { createDashboardPage } from '../miniprogram/utils/dashboard.js';
import { snapshotState } from '../miniprogram/utils/api.js';
import { buildCalendarView, buildObservationSignal, buildProgramPlanView, buildSignal } from '../miniprogram/utils/view.js';
import { indexShareTitle } from '../miniprogram/utils/share.js';

const observedAt = '2026-10-22T17:10:00.000Z';
const now = Date.parse('2026-10-22T17:30:00.000Z');
const observedForecast = {
  id: 'day17-account-observation',
  text: '额度已恢复',
  url: 'https://x.com/thsottiaux/status/123',
  status: 'observed',
  statusLabel: '已有账号实测到账',
  accountObservation: {
    announcementId: 'day17-announcement',
    observedAt,
    recordedAt: '2026-10-22T17:20:00.000Z',
    precision: 'approximate-minute',
    sourceLabel: '维护者账号实测',
  },
};
const latestAccountObservation = observedForecast.accountObservation;
const explicitForecast = {
  id: 'day18-announcement',
  text: 'Day 18: another reset is coming',
  createdAt: '2026-10-22T17:25:00.000Z',
  timing: 'pending',
  evidence: [],
};
const staleHint = {
  id: 'old-hint', text: 'Some old timing hint', intent: 3,
  createdAt: '2026-10-20T00:00:00.000Z',
  window: { from: '2026-10-22T17:00:00.000Z', to: '2026-10-24T17:00:00.000Z' },
};
const overdueForecast = { ...explicitForecast, id: 'old-announcement', status: 'overdue' };

function calendarFixture() {
  return {
    fromDate: '2026-10-05', toDate: '2026-11-01', source: 'api',
    dataAsOf: '2026-10-22T17:30:00.000Z', startWeekday: 0, days: 28,
    progressDay: 18, confirmedCount: 7, resetCount: 6, creditCount: 1,
    pendingCount: 0, datedCount: 0, observedCount: 1,
    cells: [{
      date: '2026-10-22', label: '10/22', status: 'observed', statusLabel: '实测到账',
      isToday: false, confirmedCount: 0, observedCount: 1, pendingCount: 0, datedCount: 0,
      sourceUrl: observedForecast.url,
      details: [{
        id: 'day17-account-observation', roles: ['observed', 'updated'], type: 'reset-unconfirmed',
        observedAt, observationPrecision: 'approximate-minute', sourceLabel: '维护者账号实测',
        createdAt: '2026-10-22T17:00:00.000Z', text: 'Day 17 announcement', url: observedForecast.url,
      }],
    }, {
      date: '2026-10-23', label: '10/23', status: 'future', statusLabel: '待观察',
      isToday: true, confirmedCount: 0, observedCount: 0, pendingCount: 0, datedCount: 0, details: [],
    }],
    plan: {
      title: 'Tibo 28 天计划', days: 28, latestDay: 18, reportedDays: 18, updatedDays: 12,
      resetDays: 6, sourceUrl: 'https://x.com/thsottiaux/status/program',
      rows: [{
        day: 17, status: 'observed', statusLabel: '已有账号实测到账', updateCount: 1,
        resetCount: 0, confirmedCount: 0, observedCount: 1,
        entries: [{
          id: 'day17-account-observation', kind: 'reset-unconfirmed', title: 'Day 17 / reset timing',
          text: 'Day 17: Bet you thought we forgot.', createdAt: '2026-10-22T14:55:00.000Z',
          isAccountObserved: true, observedAt, observationPrecision: 'approximate-minute',
          sourceLabel: '维护者账号实测', url: observedForecast.url,
        }],
      }, {
        day: 18, status: 'updated', statusLabel: '发布更新', updateCount: 1,
        entries: [{ id: 'day18-update', kind: 'update', isUpdate: true, title: 'Day 18 update', text: 'A new update.' }],
      }],
    },
  };
}

function signalFixture(withExplicit = false) {
  return {
    generatedAt: '2026-10-22T17:30:00.000Z',
    forecasts: withExplicit ? [explicitForecast] : [],
    observedForecasts: [observedForecast],
    latestAccountObservation,
    overdueForecasts: [overdueForecast],
    activeHints: [staleHint],
    checkedTweets: 7,
    lookbackDays: 60,
    calendar: calendarFixture(),
  };
}

function host(view = 'observe') {
  return {
    ...createDashboardPage(view),
    setData(patch, callback) {
      for (const [path, value] of Object.entries(patch)) {
        const keys = path.split('.');
        let target = this.data;
        for (const key of keys.slice(0, -1)) target = target[key];
        target[keys.at(-1)] = value;
      }
      callback?.();
    },
    tick() {}, paint() {},
  };
}

function assertObserved(signal) {
  assert.equal(signal.show, true);
  assert.equal(signal.status, 'observed');
  assert.equal(signal.level, 'observed');
  assert.equal(signal.window, null);
  assert.equal(signal.headline, null);
  assert.match(signal.observationText, /约2026\.10\.23 01:10 北京 · 维护者账号实测/);
  assert.match(signal.scopeNote, /仅代表单个账号/);
}

// Day 18 的明确预告继续压过单账号观察；没有未来预告时，实测先于过期预告和线索兜底。
assert.equal(buildSignal(signalFixture(true)).level, 'explicit');
const observedSignal = buildSignal(signalFixture(false));
assertObserved(observedSignal);
const overdueSignal = buildSignal({ ...signalFixture(false), observedForecasts: [] });
assert.equal(overdueSignal.status, 'overdue');
assert.equal(overdueSignal.badge, '落地待核实');
assert.equal(buildObservationSignal(signalFixture(true), Date.parse('2026-10-20T06:33:00.000Z'), now).level, 'explicit');

// 28 天计划与月历都显示实测状态、来源和约略时刻，公开确认数保持独立。
const calendar = calendarFixture();
const calendarView = buildCalendarView(calendar);
assert.equal(calendarView.gridCells.find((cell) => cell.date === '2026-10-22').displayLabel, '实测');
assert.equal(calendarView.observedCount, 1);
assert.equal(calendarView.confirmedCount, 7);
const planView = buildProgramPlanView(calendar.plan);
assert.equal(planView.days[16].status, 'observed');
assert.equal(planView.days[16].marker, '实');
assert.equal(planView.days[16].entries[0].labels[0].text, '已有账号实测到账');
assert.match(planView.days[16].entries[0].observationText, /约2026\.10\.23 01:10 北京 · 维护者账号实测 · 仅代表单个账号/);
assert.equal(planView.resetDays, 6);

const pageState = snapshotState();
pageState.chart = buildChartData([
  { id: 'before', announced_at: '2026-10-01T00:00:00.000Z', type: 'reset', text: 'Reset' },
  { id: 'public-last', announced_at: '2026-10-20T06:33:00.000Z', type: 'reset', text: 'Reset' },
], now);
pageState.signals = signalFixture(true);
pageState.signals.calendar = calendar;
const page = host('observe');
page.apply({ state: pageState, degraded: false });
assert.equal(page.data.signal.level, 'explicit');
assert.equal(page.data.elapsedLabel, '距上次公开确认');
assert.match(page.data.accountObservationText, /约2026\.10\.23 01:10 北京 · 维护者账号实测 · 仅代表单个账号/);
page.onSelectCalendarDay({ currentTarget: { dataset: { date: '2026-10-22' } } });
assert.match(page.data.selectedDay.details[0].when, /约2026\.10\.23 01:10 北京 · 维护者账号实测 · 仅代表单个账号/);
assert.equal(page.data.selectedDay.details[0].time, '01:10');

// 分享标题只把 explicit 当预告，不把账号观察写成官方公告。
const shareTitle = indexShareTitle({ signal: observedSignal, lastAt: Date.parse('2026-10-20T06:33:00.000Z'), now });
assert.ok(!shareTitle.includes('Tibo 预告'));

const webObserved = renderSignal(signalFixture(false), { inlineProgram: false });
assert.match(webObserved, /已有账号实测到账/);
assert.match(webObserved, /约2026\.10\.23 01:10 北京/);
assert.match(webObserved, /维护者账号实测/);
assert.match(webObserved, /仅代表单个账号；公开完成状态与其他账号到账情况仍待更新/);
assert.ok(!webObserved.includes('class="sig-win"'));
assert.ok(!webObserved.includes('id="pcd"'));
const webExplicit = renderSignal(signalFixture(true), { inlineProgram: false });
assert.ok(webExplicit.includes('data-level="explicit"'));
assert.ok(!webExplicit.includes('class="sig-observed"'));

const webPlan = renderProgramPlan(calendar.plan);
assert.match(webPlan, /plan-observed/);
assert.match(webPlan, /◇ 单账号实测/);
assert.match(webPlan, /约2026\.10\.23 01:10 北京 · 维护者账号实测 · 仅代表单个账号/);
assert.ok(!webPlan.includes('class="plan-label is-confirmed"'));
const webCalendar = renderResetCalendar(calendar);
assert.match(webCalendar, /账号实测到账<\/span><b>1/);
assert.match(webCalendar, /rc-observed/);
assert.match(webCalendar, /账号实测 1 次/);
assert.match(webCalendar, /约2026\.10\.23 01:10 北京 · 维护者账号实测/);
assert.match(webCalendar, /已确认到账<\/span><b>7<small> 次/);

const recordsFile = JSON.parse(await readFile(new URL('../data/resets.json', import.meta.url), 'utf8'));
// 固定在观察发生时回放，不能把后来采集的重置带进这个历史时钟。
const recordsAtNow = recordsFile.records.filter(record => Date.parse(record.announced_at) <= now);
const model = { ...buildChartData(recordsAtNow, now), now, generatedAt: '2026-10-22T17:30:00.000Z' };
const prediction = predictAll(recordsAtNow, { now });
const webTokens = renderAll(model, prediction, {
  ...detectSignals([], { now, account: 'thsottiaux' }),
  ...signalFixture(false),
});
assert.equal(webTokens.ELAPSED_CAPTION, '距上次公开确认');
assert.equal(webTokens.LAST_CAPTION, '上次公开确认');
assert.match(webTokens.ACCOUNT_OBSERVATION, /仅代表单个账号/);
assert.ok(webTokens.SIGNAL.includes('已有账号实测到账'));

// 静态模板也必须接入观察文案；小程序日历和计划用同一套观察标签。
const [webTemplate, indexWxml, historyWxml] = await Promise.all([
  readFile(new URL('../src/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../miniprogram/pages/index/index.wxml', import.meta.url), 'utf8'),
  readFile(new URL('../miniprogram/pages/history/index.wxml', import.meta.url), 'utf8'),
]);
assert.ok(webTemplate.includes('<!--__ACCOUNT_OBSERVATION__-->'));
assert.ok(indexWxml.includes("signal.status === 'observed' ? '已有账号实测到账'"));
assert.ok(indexWxml.includes('实 = 单账号实测（来源与时间见详情）'));
assert.ok(historyWxml.includes('{{calendar.observedCount}}'));
assert.ok(historyWxml.includes("item.observedCount ? '实测'"));

// Mutant check：如果观察状态被改回普通线索，上面的行为断言必须失败；源码哈希保持不变。
const viewUrl = new URL('../miniprogram/utils/view.js', import.meta.url);
const viewSource = await readFile(viewUrl, 'utf8');
const originalHash = createHash('sha256').update(viewSource).digest('hex');
const mutantSource = viewSource.replace("status: 'observed',\n    createdAt: observation.observedAt", "status: 'hint',\n    createdAt: observation.observedAt");
assert.notEqual(mutantSource, viewSource, 'mutant replacement must match the intended status');
const mutantImportable = mutantSource.replace(/from (['"])(\.[^'"]+)\1/g, (_, quote, specifier) =>
  `from ${quote}${new URL(specifier, viewUrl).href}${quote}`);
const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantImportable).toString('base64')}`);
assert.throws(() => assertObserved(mutant.buildSignal(signalFixture(false))));
assert.equal(createHash('sha256').update(await readFile(viewUrl)).digest('hex'), originalHash);

console.log('✓ account observation UI contract: official forecast priority, explicit single-account evidence, calendar/plan/web labels, public counts, share semantics, and source mutant/hash proof');
