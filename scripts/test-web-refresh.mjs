#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { renderDigest } from '../src/lib/render.mjs';
import { derive } from '../src/lib/page.mjs';
import { snapshotFrom } from '../src/lib/snapshot.mjs';

let passed = 0;
const check = (name, value) => { assert.ok(value, name); passed++; console.log(`✓ ${name}`); };
const template = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const script = template.match(/<script id="state-refresh">([\s\S]*?)<\/script>/)?.[1];
const at = '2026-10-15T06:00:00.000Z';
const next = '2026-10-15T07:00:00.000Z';
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function boot({ state = { dataUpdatedAt: at }, errors = [], digestRevision = '', manualRevision = 0, scriptOverride = script, stored = null, hidden = false, pending = false } = {}) {
  const boxes = { '.sig-prog': { open: true }, '.am-more': { open: false } };
  const calls = [], timers = [], intervals = [], events = {}, removed = [];
  const store = new Map(stored ? [['reset-observatory-reading', JSON.stringify(stored)]] : []);
  let reloaded = 0, scrolled = null, resized = 0, resolveRequest;
  let outcome = state;
  const document = {
    hidden,
    getElementById: () => ({ textContent: JSON.stringify({ dataUpdatedAt: at, builtAt: next, accountObservationRevision: digestRevision, manualRevision, collectErrors: errors }) }),
    querySelector: selector => boxes[selector],
    addEventListener: (name, callback) => { events[name] = callback; },
  };
  const response = () => {
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve({ ok: outcome !== null, json: async () => outcome });
  };
  runInNewContext(scriptOverride, {
    document,
    location: { pathname: '/', reload: () => { reloaded++; } },
    window: { scrollY: 432, scrollTo: (x, y) => { scrolled = y; }, dispatchEvent: () => { resized++; } },
    sessionStorage: { getItem: k => store.get(k) ?? null, removeItem: k => { removed.push(k); store.delete(k); }, setItem: (k, v) => store.set(k, v) },
    fetch: (url, options) => {
      calls.push({ url, options });
      if (!pending) return response();
      return new Promise(resolve => { resolveRequest = resolve; });
    },
    AbortController, Event,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: t => { t.cleared = true; },
    requestAnimationFrame: fn => fn(),
  });
  return { document, boxes, calls, timers, intervals, events, store, removed,
    get reloaded() { return reloaded; }, get scrolled() { return scrolled; }, get resized() { return resized; },
    resolve: () => resolveRequest({ ok: true, json: async () => outcome }),
    outcome: value => { outcome = value; },
  };
}
const digest = JSON.parse(renderDigest({ now: Date.parse(next), generatedAt: next, dataUpdatedAt: at, accountObservationRevision: 'rev-1', lastAt: at }, null, null));
check('网页摘要包含采集时刻和账号观察修订号', digest.dataUpdatedAt === at && digest.builtAt === next && digest.accountObservationRevision === 'rev-1');
const same = boot({ state: { dataUpdatedAt: at, generatedAt: next } });
await settle();
check('网页初次与每分钟检查状态且不使用 HTTP 缓存', same.calls[0]?.url === '/api/state?tweets=0' && same.calls[0]?.options.cache === 'no-store' && same.intervals[0]?.ms === 60000);
check('仅 API 请求时刻变化不重载网页', same.reloaded === 0);
const sameDataObservation = boot({ digestRevision: 'rev-1', state: { dataUpdatedAt: at, signals: { accountObservationRevision: 'rev-1' } } });
await settle();
check('账号观察修订号未变化时不重载网页', sameDataObservation.reloaded === 0);
sameDataObservation.outcome({ dataUpdatedAt: at, signals: { accountObservationRevision: 'rev-2' } });
await sameDataObservation.intervals[0].fn();
check('推文采集时刻不变但账号观察修订时仍重载', sameDataObservation.reloaded === 1);
const sameManual = boot({ manualRevision: 3, state: { dataUpdatedAt: at, signals: { manualRevision: 3 } } });
await settle();
check('手动修订号未变化不重载', sameManual.reloaded === 0);
sameManual.outcome({ dataUpdatedAt: at, signals: { manualRevision: 4 } });
await sameManual.intervals[0].fn();
check('采集时刻不变时手动保存或撤销也重载', sameManual.reloaded === 1);
const disabledManual = script.replace(/var manualChanged = [^;]+;/, 'var manualChanged = false;');
assert.notEqual(disabledManual, script, '手工修订刷新变异点存在');
const missedManual = boot({ scriptOverride: disabledManual, manualRevision: 3, state: { dataUpdatedAt: at, signals: { manualRevision: 4 } } });
await settle();
check('关闭手工修订分支的隔离反例会漏刷新', missedManual.reloaded === 0);
same.outcome({ dataUpdatedAt: next });
await same.intervals[0].fn();
check('新一轮数据到达会重载服务端页面', same.reloaded === 1);
const reading = JSON.parse(same.store.get('reset-observatory-reading') ?? '{}');
check('更新前保存阅读位置及开关状态', reading.scrollY === 432 && reading.open['.sig-prog'] === true && reading.open['.am-more'] === false);
await same.intervals[0].fn();
check('正在重载时不重复请求或重载', same.calls.length === 2 && same.reloaded === 1);
const restored = boot({ stored: { path: '/', at: Date.now(), scrollY: 123, open: { '.sig-prog': false, '.am-more': true } } });
await settle();
check('更新后恢复阅读位置和展开状态并清除临时记录', restored.scrolled === 123 && restored.boxes['.sig-prog'].open === false && restored.boxes['.am-more'].open === true && restored.removed.length === 1 && restored.resized === 1);
const hidden = boot({ hidden: true });
await settle();
check('后台网页不轮询', hidden.calls.length === 0);
hidden.document.hidden = false;
await hidden.events.visibilitychange();
check('回到网页前台立即检查状态', hidden.calls.length === 1);
const pending = boot({ pending: true });
pending.intervals[0].fn();
await settle();
check('慢请求期间不重叠发送', pending.calls.length === 1);
pending.document.hidden = true;
pending.outcome({ dataUpdatedAt: next });
pending.resolve();
await settle();
check('响应到达时已在后台不触发重载', pending.reloaded === 0);
const offline = boot({ state: new Error('offline') });
await settle();
offline.outcome({ dataUpdatedAt: next });
await offline.intervals[0].fn();
check('请求失败后保留页面且下一轮可以恢复', offline.calls.length === 2 && offline.reloaded === 1);
const unavailable = boot({ state: null });
await settle();
check('没有状态 API 的静态页面不被重载', unavailable.reloaded === 0 && unavailable.timers[0].cleared);
const hung = boot({ pending: true });
hung.timers[0].fn();
check('状态请求超过八秒会中止', hung.timers[0].ms === 8000 && hung.calls[0].options.signal.aborted);
hung.resolve();
await settle();
const failed = { dataUpdatedAt: at, generatedAt: next, collectErrors: ['offline'] };
const newFailure = boot({ state: failed });
await settle();
check('采集失败只在错误状态变化时重载一次', newFailure.reloaded === 1);
const repeatFailure = boot({ state: failed, errors: ['offline'] });
await settle();
await repeatFailure.intervals[0].fn();
check('相同采集错误和运行时刻变化不反复重载', repeatFailure.reloaded === 0);
const recovered = boot({ errors: ['offline'] });
await settle();
check('错误解除即使没有新帖子也刷新提示', recovered.reloaded === 1);
const statsFile = { generated_at: next, errors: ['offline'] };
const tweets = { updated_at: at, tweets: [] };
const derived = derive({ now: Date.parse(next), account: 'thsottiaux', statsFile, tweets,
  resets: { records: [{ announced_at: '2026-10-01T00:00:00Z', type: 'reset' }, { announced_at: '2026-10-03T00:00:00Z', type: 'reset' }] } });
const pageDigest = JSON.parse(renderDigest(derived.model, derived.prediction, null));
check('页面模型成功数据时刻不随失败采集推进并保留错误状态', pageDigest.dataUpdatedAt === at && pageDigest.collectErrors?.[0] === 'offline' && derived.model.generatedAt === next);
const serverSource = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8');
const route = serverSource.match(/'\/api\/state': async \(url\) => \{([\s\S]*?)\n  \},/)[1];
const stateRoute = runInNewContext(`(async (url) => {${route}})`, {
  store: { getData: async () => ({ statsFile, tweets }) },
  getPrediction: async () => null, getSignals: async () => null, getChart: async () => null, DEFAULT_CONFIG: {},
});
const api = await stateRoute(new URL('http://localhost/api/state?tweets=0'));
check('状态 API 成功数据时刻不随失败采集推进', api.dataUpdatedAt === at && api.collectErrors[0] === 'offline');
const snapshot = snapshotFrom({ ...derived, statsFile, tweets, now: Date.parse(next) });
const snapshotData = JSON.parse(snapshot.split('export default ')[1].replace(/;\s*$/, ''));
check('小程序快照成功数据时刻不随失败采集推进', snapshotData.dataUpdatedAt === at && snapshotData.collectErrors[0] === 'offline');
const buildSource = await readFile(new URL('./build.mjs', import.meta.url), 'utf8');
const snapshotSource = await readFile(new URL('../src/lib/snapshot.mjs', import.meta.url), 'utf8');
check('两条快照生成入口都传递成功采集时刻', /snapshotFrom\(\{[^}]*\btweets\b/.test(buildSource) && /return snapshotFrom\(\{[^}]*\btweets\b/.test(snapshotSource));
console.log(`✓ 网页刷新 ${passed} 项通过`);
