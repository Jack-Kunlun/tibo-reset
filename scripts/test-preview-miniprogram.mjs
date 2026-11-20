#!/usr/bin/env node
/** 预览复用真实页面映射，只读刷新后台补录；失败不能退回旧采集数据。 */
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createDashboardPage } from '../miniprogram/utils/dashboard.js';
import { buildChartData } from '../src/lib/chart-data.js';
import { snapshotState } from '../miniprogram/utils/api.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../dist/miniprogram-preview.html', import.meta.url);
const previous = await readFile(output).catch(() => null);
const settled = () => new Promise(resolve => setImmediate(resolve));
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('✓ ' + name); };

try {
  await promisify(execFile)(process.execPath, ['scripts/preview-miniprogram.mjs', '--api-base=https://preview-api.example.invalid'], { cwd: root });
  const html = await readFile(output, 'utf8');
  const json = id => JSON.parse(html.match(new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)<\\/script>`))[1]);
  const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import[^\n]*\n/gm, '');
  const base = snapshotState();
  const fixtureDays = [26, 28, 29];
  const fixtureDate = day => `2026-10-${String(day).padStart(2, '0')}`;
  const fixtureRecords = fixtureDays.slice(0, 2).map(day => ({ id: `fixture-manual-${day}`, type: 'reset', announced_at: `${fixtureDate(day)}T06:36:00Z`, text: '维护者确认到账' }));
  const historicalCells = Array.from({ length: 31 }, (_, index) => {
    const day = index + 1, date = fixtureDate(day), selected = fixtureDays.includes(day), updated = day === 29;
    return { date, label: `10/${String(day).padStart(2, '0')}`, status: updated ? 'updated' : selected ? 'confirmed' : 'elapsed-no-record',
      statusLabel: updated ? '功能更新' : selected ? '已到账' : '暂无记录', confirmedCount: selected && !updated ? 1 : 0,
      observedCount: 0, pendingCount: 0, datedCount: 0,
      details: selected ? [{ id: `fixture-manual-${day}`, text: `维护者补录 ${day} 日`, roles: updated ? ['updated'] : ['confirmed'],
        confirmedAt: updated ? null : `${date}T06:36:00Z`, createdAt: `${date}T06:36:00Z`, manual: true, type: 'reset' }] : [] };
  });
  const makeMonth = (month, days, cells, progressDay) => ({ month, title: `${month.slice(0, 4)}年${Number(month.slice(5))}月重置日历`,
    fromDate: `${month}-01`, toDate: `${month}-${String(days).padStart(2, '0')}`, days, startWeekday: 0, progressDay,
    confirmedCount: cells.reduce((count, cell) => count + cell.confirmedCount, 0), resetCount: cells.reduce((count, cell) => count + cell.confirmedCount, 0),
    creditCount: 0, observedCount: 0, datedCount: 0, pendingCount: 0, fulfilledForecastCount: 0,
    updatedCount: cells.filter(cell => cell.status === 'updated').length, cells, weeks: [], hasManual: cells.some(cell => cell.details.some(detail => detail.manual)), zone: 'Asia/Shanghai' });
  const previousMonth = makeMonth('2026-10', 31, historicalCells, 31);
  const currentMonth = makeMonth('2026-11', 30, Array.from({ length: 30 }, (_, index) => {
    const day = index + 1, date = `2026-11-${String(day).padStart(2, '0')}`;
    return { date, label: `11/${String(day).padStart(2, '0')}`, status: day === 15 ? 'today' : 'elapsed-no-record',
      statusLabel: day === 15 ? '今天' : '暂无记录', isToday: day === 15, confirmedCount: 0, observedCount: 0, pendingCount: 0, datedCount: 0, details: [] };
  }), 15);
  const calendar = { ...base.signals.calendar, ...currentMonth, currentMonth: '2026-11', earliestMonth: '2026-10',
    months: [previousMonth, currentMonth], plan: base.signals.calendar?.plan };
  const remote = { ...base, source: 'api', chart: buildChartData(fixtureRecords, Date.parse('2026-10-30T07:00:00Z')),
    signals: { ...base.signals, manualRevision: 4, calendar } };
  function boot(result = remote, override = source) {
    const status = { textContent: '' }, rootNode = { innerHTML: '', querySelector: () => null };
    const payloads = { 'preview-data': JSON.stringify(json('preview-data')), 'chart-data': JSON.stringify(json('chart-data')) };
    const requests = [], events = {}, intervals = [];
    let outcome = result;
    const context = {
      createDashboardPage, AbortSignal, structuredClone,
      document: { hidden: false, body: { style: {} }, documentElement: { style: {} },
        getElementById: id => id === 'preview-data-status' ? status : id === 'preview-page-root' ? rootNode : { textContent: payloads[id] },
        querySelectorAll: () => [], createElement: () => ({ style: {} }),
        addEventListener: (name, fn) => { events[name] = fn; } },
      window: { devicePixelRatio: 1 },
      requestAnimationFrame: fn => fn(), setInterval: (fn, ms) => { intervals.push({ fn, ms }); },
      fetch: async (url, options) => { requests.push({ url, options }); if (outcome instanceof Error) throw outcome; return { ok: true, json: async () => structuredClone(outcome) }; },
    };
    rootNode.addEventListener = () => {};
    runInNewContext(override + '\n globalThis.probe = { instances, refreshFromApi, handle, selectView };', context);
    return { ...context.probe, requests, status, events, intervals, rootNode, outcome: value => { outcome = value; } };
  }
  const preview = boot();
  await settled();
  check('普通预览只读获取同一状态接口，禁用 HTTP 缓存', () => {
    assert.equal(preview.requests.length, 1);
    assert.equal(preview.requests[0].url, 'https://preview-api.example.invalid/api/state?tweets=0');
    assert.equal(preview.requests[0].options.cache, 'no-store');
    assert.equal(preview.intervals[0].ms, 60000);
  });
  check('三个页面全部接收含后台补录的接口结果', () => {
    for (const page of Object.values(preview.instances)) {
      assert.equal(page.data.recordCount, 2);
      assert.equal(page.data.selectedCalendarMonth, '2026-11');
      assert.equal(page.data.calendar.cells.length, 30);
      assert.equal(page.data.degraded, false);
    }
    assert.match(preview.status.textContent, /含后台补录/);
  });
  preview.selectView('records');
  check('记录页预览将原生月份选择器映射为可操作的选择控件', () => {
    assert.match(preview.rootNode.innerHTML, /<select[^>]*tr-calendar-month-picker[^>]*data-preview-change="onSelectCalendarMonth"/);
    assert.match(preview.rootNode.innerHTML, /<option value="0">2026 年 10 月<\/option>/);
    assert.match(html, /\.preview-page select\.tr-calendar-month-picker\{[^}]*border:0[^}]*color:#f2f0fc[^}]*font:inherit/);
  });
  preview.handle('onSelectCalendarMonth', { detail: { value: 0 }, currentTarget: { dataset: {} } });
  check('记录页预览可切到最早月份并保留根层计划', () => {
    assert.equal(preview.instances.records.data.selectedCalendarMonth, '2026-10');
    assert.equal(preview.instances.records.data.calendar.cells.length, 31);
    assert.equal(preview.instances.records.data.calendar.plan?.title, remote.signals.calendar.plan?.title);
    assert.equal(preview.instances.records.data.calendarCanPrev, false);
  });
  preview.handle('onSelectCalendarDay', { currentTarget: { dataset: { date: fixtureDate(28) } } });
  check('点选日期使用刷新后的明细，不复用构建时的旧选择表', () => {
    assert.equal(preview.instances.records.data.selectedDay.details[0].text, '维护者补录 28 日');
    assert.equal(preview.instances.records.data.selectedDay.details[0].title, '重置已确认');
  });
  const next = structuredClone(remote);
  next.signals.manualRevision++;
  next.signals.calendar.months[0].cells.find(cell => cell.date === fixtureDate(28)).details[0].text = '同一采集时刻的新补录';
  preview.outcome(next);
  await preview.refreshFromApi();
  check('成功采集时间不变，后台修订也更新且保留当前选择', () => {
    assert.equal(next.dataUpdatedAt, remote.dataUpdatedAt);
    assert.equal(preview.instances.records.data.selectedCalendarMonth, '2026-10');
    assert.equal(preview.instances.records.data.selectedDate, fixtureDate(28));
    assert.equal(preview.instances.records.data.selectedDay.details[0].text, '同一采集时刻的新补录');
  });
  preview.outcome(new Error('offline'));
  await preview.refreshFromApi();
  check('网络失败保留上次联网数据，并显示降级原因', () => {
    assert.equal(preview.instances.records.data.recordCount, 2);
    assert.equal(preview.instances.records.data.selectedCalendarMonth, '2026-10');
    assert.equal(preview.instances.records.data.selectedDay.details[0].text, '同一采集时刻的新补录');
    assert.equal(preview.instances.records.data.degraded, true);
    assert.match(preview.instances.records.data.notice, /保留上次联网数据/);
    assert.match(preview.status.textContent, /同步失败/);
  });
  const offline = boot(new Error('offline'));
  await settled();
  check('首次联网失败只保留明确标识的本地快照', () => {
    assert.equal(offline.instances.observe.data.degraded, true);
    assert.match(offline.instances.observe.data.notice, /本地采集快照/);
    assert.match(offline.status.textContent, /同步失败/);
  });
  const isolated = boot(remote, source.replace(/const previewApiBase = [^;]+;/, 'const previewApiBase = "";'));
  await settled();
  check('隔离布局预览不发网络请求', () => assert.equal(isolated.requests.length, 0));
  console.log(`\n${checks} 组预览刷新回归通过；未发真实请求或运行微信授权、订阅。`);
} finally {
  if (previous) await writeFile(output, previous);
  else await rm(output, { force: true });
}
