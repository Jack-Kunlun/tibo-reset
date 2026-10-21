#!/usr/bin/env node
/** 原生三个 Tab 的数据、日期选择与前后台边界。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDashboardPage } from '../miniprogram/utils/dashboard.js';
import { buildObservationSignal } from '../miniprogram/utils/view.js';
import { snapshotState } from '../miniprogram/utils/api.js';
import { buildChartData } from '../src/lib/chart-data.js';

const now = Date.parse('2026-10-21T02:00:00Z');
function host(view) {
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
function state() {
  const records = Array.from({ length: 27 }, (_, i) => ({
    id: `fixture-${i}`, announced_at: new Date(now - (27 - i) * 86400000).toISOString(), type: 'reset', text: 'reset',
  }));
  return { ...structuredClone(snapshotState()), chart: buildChartData(records, now) };
}

test('记录页展示全部历史且不修改双端共享的时间顺序', () => {
  const input = state();
  const expected = input.chart.records.map(r => r.id);
  Object.freeze(input.chart.records);
  const records = host('records');
  records.apply({ state: input, degraded: false });
  assert.equal(records.data.allRecords.length, 27);
  assert.deepEqual(records.data.allRecords.map(r => r.key), expected.toReversed());
  assert.deepEqual(input.chart.records.map(r => r.id), expected);
});

test('三个页面展开状态独立，分享链接指向各自 Tab', () => {
  const observe = host('observe'), records = host('records'), analysis = host('analysis');
  analysis.onToggleAnalysis({ currentTarget: { dataset: { section: 'history' } } });
  assert.equal(analysis.data.analysisOpen.history, true);
  assert.equal(observe.data.analysisOpen.history, false);
  assert.equal(records.data.analysisOpen.history, false);
  analysis.onToggleAnalysis({ currentTarget: { dataset: { section: 'invalid' } } });
  assert.equal(Object.keys(analysis.data.analysisOpen).length, 6);
  assert.deepEqual([observe, records, analysis].map(p => p.onShareAppMessage().path),
    ['/pages/index/index', '/pages/history/index', '/pages/analysis/index']);
});

test('分析柱图取最近十二个真实间隔，少量配对不产生零耗时估计', () => {
  const input = state();
  input.chart.gapDays = Array.from({ length: 26 }, (_, index) => index + 1);
  input.prediction = { ...input.prediction, announcementDelay: { sampleCount: 2, medianMs: null, minMs: null, maxMs: null } };
  const page = host('analysis');
  page.apply({ state: input, degraded: false });
  assert.deepEqual(page.data.trendBars.map(bar => Number(bar.value)), input.chart.gapDays.slice(-12));
  assert.equal(page.data.trendBars.filter(bar => bar.latest).length, 1);
  assert.equal(page.data.trendBars.at(-1).latest, true);
  assert.equal(page.data.trendBars.at(-1).height, 100);
  assert.deepEqual(page.data.arrival, { count: 2, median: '样本不足', range: '—' });
});

test('日历日期可选择，静默刷新保留选择，消失日期回退到最近确认', () => {
  const input = state();
  const cells = ['2026-10-19', '2026-10-20'].map((date, i) => ({
    date, label: date.slice(5), status: 'confirmed', statusLabel: '已到账', confirmedCount: 1,
    pendingCount: 0, details: [{ id: `cal-${i}`, roles: ['confirmed'], type: 'reset',
      confirmedAt: `${date}T23:30:00Z`, text: 'Reset complete', url: 'https://x.com/example' }],
  }));
  input.signals = { ...input.signals, calendar: { ...input.signals.calendar, cells } };
  const page = host('records');
  page.apply({ state: input, degraded: false });
  assert.equal(page.data.selectedDate, '2026-10-20');
  page.onSelectCalendarDay({ currentTarget: { dataset: { date: '2026-10-19' } } });
  assert.equal(page.data.selectedDay.date, '2026.10.19');
  assert.equal(page.data.selectedDay.details[0].when, '2026.10.20 07:30 北京');
  page.onSelectCalendarDay({ currentTarget: { dataset: { date: '2099-01-01' } } });
  assert.equal(page.data.selectedDate, '2026-10-19');
  page.apply({ state: input, degraded: false, preserveUi: true });
  assert.equal(page.data.selectedDate, '2026-10-19');
  input.signals.calendar.cells = cells.slice(1);
  page.apply({ state: input, degraded: false, preserveUi: true });
  assert.equal(page.data.selectedDate, '2026-10-20');
});

test('切回页面读取共享缓存，隐藏后停止计时且记录和分析不查询提醒', () => {
  for (const view of ['records', 'analysis']) {
    const page = host(view), calls = [];
    page._lastLoad = Date.now();
    page.load = opts => calls.push(opts);
    page.startTicker = () => {};
    page.stopTicker = () => { page.stopped = true; };
    page.refreshReminders = () => { throw new Error('提醒只在观测页查询'); };
    page.onShow();
    assert.deepEqual(calls, [{ silent: true, force: false }]);
    page.onHide();
    assert.equal(page.data.pageVisible, false);
    assert.equal(page.stopped, true);
  }
});

test('查看预测依据走原生 Tab，单页模式不发起跳转', () => {
  const saved = globalThis.wx, calls = [];
  globalThis.wx = { switchTab: opts => calls.push(opts.url) };
  try {
    const page = host('observe');
    page.onOpenAnalysis();
    page.data.singlePage = true;
    page.onOpenAnalysis();
    assert.deepEqual(calls, ['/pages/analysis/index']);
  } finally { globalThis.wx = saved; }
});

test('复用页面重返朋友圈单页时同步隐藏提醒和剪贴板，普通入口可恢复', () => {
  const saved = globalThis.wx;
  let scene = 1001, refreshes = 0, clipboard = 0;
  globalThis.wx = { getEnterOptionsSync: () => ({ scene }), getWindowInfo: () => ({ statusBarHeight: 44 }),
    setClipboardData() { clipboard++; } };
  try {
    const page = host('observe');
    page.startTicker = () => {};
    page.refreshReminders = () => { refreshes++; };
    page.onShow();
    page.onHide();
    scene = 1154;
    page.onShow();
    assert.equal(page.data.singlePage, true);
    assert.equal(page.data.nav.statusBarHeight, 0);
    assert.equal(page.data.announcementRemind.show, false);
    assert.equal(page.data.landedRemind.show, false);
    assert.equal(refreshes, 1);
    page.onCopySource({ currentTarget: { dataset: { url: 'https://x.com/example' } } });
    assert.equal(clipboard, 0);
    page.onHide();
    scene = 1001;
    page.onShow();
    assert.equal(page.data.singlePage, false);
    assert.equal(page.data.nav.statusBarHeight, 44);
    assert.equal(page.data.announcementRemind.show, true);
    assert.equal(page.data.landedRemind.show, true);
    assert.equal(refreshes, 2);
  } finally { globalThis.wx = saved; }
});

test('首页只置顶上次重置后仍有效的线索，线索不能升级为明确预告', () => {
  const floor = now - 3600000;
  const hint = { id: 'hint', intent: 3, createdAt: new Date(now - 600000).toISOString(), text: 'reset soon' };
  const base = { forecasts: [], hints: [hint], windowFrom: new Date(floor - 3600000).toISOString() };
  const result = buildObservationSignal(base, floor, now);
  assert.equal(result.show, true);
  assert.equal(result.level, 'hint');
  assert.equal(result.title, '有新的额度相关发言');
  for (const change of [
    { createdAt: new Date(floor).toISOString() },
    { createdAt: new Date(now + 1000).toISOString() },
    { intent: 0 },
    { window: { to: new Date(now - 1000).toISOString() } },
  ]) assert.equal(buildObservationSignal({ ...base, hints: [{ ...hint, ...change }] }, floor, now).show, false);
  const explicit = { id: 'forecast', text: 'We will reset', pending: true, evidence: [], createdAt: hint.createdAt };
  assert.equal(buildObservationSignal({ ...base, forecasts: [explicit] }, floor, now).level, 'explicit');
});
