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
  const fixtureRecords = ['26', '28'].map(day => ({ id: `fixture-manual-${day}`, type: 'reset', announced_at: `2026-10-${day}T06:36:00Z`, text: '维护者确认到账' }));
  const cells = ['26', '28', '29'].map(day => ({ date: `2026-10-${day}`, label: `10/${day}`,
    status: day === '29' ? 'updated' : 'confirmed', statusLabel: day === '29' ? '功能更新' : '已到账',
    confirmedCount: day === '29' ? 0 : 1, pendingCount: 0, datedCount: 0,
    details: [{ id: `fixture-manual-${day}`, text: `维护者补录 ${day} 日`, roles: day === '29' ? ['updated'] : ['confirmed'], confirmedAt: day === '29' ? null : `2026-10-${day}T06:36:00Z`, createdAt: `2026-10-${day}T06:36:00Z`, manual: true, type: 'reset' }],
  }));
  const remote = { ...base, source: 'api', chart: buildChartData(fixtureRecords, Date.parse('2026-10-30T07:00:00Z')),
    signals: { ...base.signals, manualRevision: 4, calendar: { ...base.signals.calendar, confirmedCount: 2, pendingCount: 0, datedCount: 0, cells } } };
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
    runInNewContext(override + '\n globalThis.probe = { instances, refreshFromApi, handle };', context);
    return { ...context.probe, requests, status, events, intervals, outcome: value => { outcome = value; } };
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
      assert.equal(page.data.calendar.cells.find(c => c.date === '2026-10-28').confirmedCount, 1);
      assert.equal(page.data.degraded, false);
    }
    assert.match(preview.status.textContent, /含后台补录/);
  });
  preview.handle('onSelectCalendarDay', { currentTarget: { dataset: { date: '2026-10-28' } } });
  check('点选日期使用刷新后的明细，不复用构建时的旧选择表', () => {
    assert.equal(preview.instances.observe.data.selectedDay.details[0].text, '维护者补录 28 日');
    assert.equal(preview.instances.observe.data.selectedDay.details[0].title, '重置已确认');
  });
  const next = structuredClone(remote);
  next.signals.manualRevision++;
  next.signals.calendar.cells[1].details[0].text = '同一采集时刻的新补录';
  preview.outcome(next);
  await preview.refreshFromApi();
  check('成功采集时间不变，后台修订也更新且保留当前选择', () => {
    assert.equal(next.dataUpdatedAt, remote.dataUpdatedAt);
    assert.equal(preview.instances.observe.data.selectedDate, '2026-10-28');
    assert.equal(preview.instances.observe.data.selectedDay.details[0].text, '同一采集时刻的新补录');
  });
  preview.outcome(new Error('offline'));
  await preview.refreshFromApi();
  check('网络失败保留上次联网数据，并显示降级原因', () => {
    assert.equal(preview.instances.observe.data.recordCount, 2);
    assert.equal(preview.instances.observe.data.selectedDay.details[0].text, '同一采集时刻的新补录');
    assert.equal(preview.instances.observe.data.degraded, true);
    assert.match(preview.instances.observe.data.notice, /保留上次联网数据/);
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
