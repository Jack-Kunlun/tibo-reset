#!/usr/bin/env node
/** 真实服务进程 + 隔离数据卷，MyMemory 出口由 preload 拦截，不触发真实微信或翻译请求。 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { createStore } from '../server/store.mjs';
import { derive } from '../src/lib/page.mjs';
import { snapshotFrom } from '../src/lib/snapshot.mjs';
import { buildSignal } from '../miniprogram/utils/view.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const folder = await mkdtemp(resolve(tmpdir(), 'tibo-auto-translation-runtime-'));
const gate = resolve(folder, 'release');
const requestLog = resolve(folder, 'requests.jsonl');
const modeFile = resolve(folder, 'mode');
const preload = resolve(folder, 'provider.mjs');
let child, closed, output = '';
const time = Date.now();
const now = new Date(time).toISOString();
const first = { id: '2119999999999999101', account: 'thsottiaux', author_verified: true,
  foundVia: 'timeline-browser', role: 'post', created_at: now,
  url: 'https://x.com/thsottiaux/status/2119999999999999101',
  text: 'We will reset all usage limits tomorrow.' };
const second = { ...first, id: '2119999999999999102',
  url: 'https://x.com/thsottiaux/status/2119999999999999102',
  text: 'We will reset all usage limits tomorrow, before 10am PST.' };
const raw = { updated_at: new Date(time - 60_000).toISOString(), tweets: [{ ...first,
  id: '2119999999999999001', url: 'https://x.com/thsottiaux/status/2119999999999999001',
  text: 'A small unrelated update.', created_at: new Date(time - 2 * 3600_000).toISOString() }] };
const resets = { records: Array.from({ length: 24 }, (_, index) => ({ id: `history-${index}`, type: 'reset',
  announced_at: new Date(time - (4 + index * 2) * 86400_000).toISOString() })) };

async function waitFor(check, label) {
  for (let index = 0; index < 160; index++) {
    const result = await check();
    if (result) return result;
    await pause(25);
  }
  throw new Error(`${label}\n${output.slice(-1600)}`);
}

try {
  await Promise.all([
    writeFile(resolve(folder, 'tweets.json'), JSON.stringify(raw)),
    writeFile(resolve(folder, 'resets.json'), JSON.stringify(resets)),
    writeFile(resolve(folder, 'stats.json'), JSON.stringify({ generated_at: raw.updated_at, errors: [] })),
  ]);
  await writeFile(modeFile, 'success');
  await writeFile(preload, `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.hostname !== 'api.mymemory.translated.net') return nativeFetch(input, options);
  appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ q: url.searchParams.get('q'), language: url.searchParams.get('langpair') }) + '\\n');
  while (!existsSync(${JSON.stringify(gate)})) {
    options.signal?.throwIfAborted();
    await pause(5);
  }
  const quota = readFileSync(${JSON.stringify(modeFile)}, 'utf8') === 'quota';
  return new Response(JSON.stringify(quota
    ? { responseStatus: 429, responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' } }
    : { responseStatus: 200, responseData: { translatedText: '明天将重置所有使用额度。' } }),
    { status: quota ? 429 : 200, headers: { 'content-type': 'application/json' } });
};
`);
  const reserve = createServer();
  await new Promise((done) => reserve.listen(0, '127.0.0.1', done));
  const port = reserve.address().port;
  await new Promise((done) => reserve.close(done));
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', preload, 'server/index.mjs'], { cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: folder, COLLECT_INTERVAL_MIN: '0', AUTO_TRANSLATE: '1',
      WX_APPID: '', WX_SECRET: '', INGEST_TOKEN: 'isolated-translation-token', ADMIN_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  closed = new Promise((done) => child.once('close', done));
  child.stdout.on('data', (bytes) => { output += bytes; });
  child.stderr.on('data', (bytes) => { output += bytes; });
  await waitFor(async () => { try { return (await fetch(baseUrl + '/api/health')).ok; } catch { return false; } }, '服务启动');
  const baseline = JSON.parse(await readFile(resolve(folder, 'translation-cache.json'), 'utf8'));
  assert.equal(baseline.revision, 0);
  assert.equal(baseline.entries[first.id], undefined);
  const state = async () => (await fetch(baseUrl + '/api/state?tweets=0')).json();
  const initial = await state();
  const ingest = async (tweets, offset) => {
    const at = new Date(time + offset).toISOString();
    const response = await fetch(baseUrl + '/api/ingest', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer isolated-translation-token' },
      body: JSON.stringify({ generatedAt: at, resets, tweets: { ...raw, updated_at: at, tweets }, stats: { errors: [] } }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'accepted');
    return at;
  };
  const updatedAt = await ingest([first, ...raw.tweets], 100);
  await waitFor(async () => { try { return (await readFile(requestLog, 'utf8')).length > 0; } catch { return false; } }, '后台翻译发起');
  const before = await state();
  const evidenceFor = (snapshot, id) => (snapshot.signals.forecasts ?? []).flatMap((forecast) => forecast.evidence ?? []).find((item) => String(item.id) === id);
  assert.equal(evidenceFor(before, first.id)?.translation, undefined);
  assert.equal(evidenceFor(before, first.id)?.text, first.text);
  assert.equal(before.chart.count, initial.chart.count, '待翻译时保持原重置计数');
  assert.equal(before.dataUpdatedAt, updatedAt, '采集响应无需等待翻译');
  const incomingBytes = await readFile(resolve(folder, 'tweets.json'), 'utf8');
  await writeFile(gate, 'release');
  const after = await waitFor(async () => {
    const snapshot = await state();
    return evidenceFor(snapshot, first.id)?.translation?.provider === 'mymemory' ? snapshot : null;
  }, '译文进入实时 API');
  assert.equal(after.signals.translationRevision, 1);
  assert.deepEqual(after.signals.counts, before.signals.counts, '译文不改变信号判定');
  assert.equal(after.chart.count, before.chart.count);
  assert.equal(after.dataUpdatedAt, updatedAt, '译文不冒充成功采集时刻');
  assert.equal(await readFile(resolve(folder, 'tweets.json'), 'utf8'), incomingBytes, '译文不写入采集源文件');
  const page = await (await fetch(baseUrl + '/')).text();
  assert.match(page, /明天将重置所有使用额度/);
  const management = await (await fetch(baseUrl + '/api/manage')).json();
  assert.equal(management.tweets.find((tweet) => tweet.id === first.id).translation.provider, 'mymemory');
  const data = await createStore(folder).getData();
  const derived = derive({ ...data, now: Date.now(), account: 'thsottiaux' });
  const snapshotText = snapshotFrom({ ...derived, tweets: data.tweets, statsFile: data.statsFile, now: Date.now(), account: 'thsottiaux' });
  assert.match(snapshotText, /明天将重置所有使用额度/);
  assert.ok(buildSignal(derived.signals).ev.some((item) => item.translation === '明天将重置所有使用额度。'));
  await writeFile(modeFile, 'quota');
  await ingest([second, first, ...raw.tweets], 200);
  await waitFor(async () => JSON.parse(await readFile(resolve(folder, 'translation-cache.json'), 'utf8')).blockedUntil, '超额回退落盘');
  const limited = await state();
  assert.equal(evidenceFor(limited, second.id)?.translation, undefined);
  assert.equal(evidenceFor(limited, second.id)?.text, second.text);
  assert.ok(!JSON.stringify(limited).includes('MYMEMORY WARNING'), '错误响应不混入用户可见译文');
  assert.equal(limited.signals.translationRevision, 1);
  const cachePath = resolve(folder, 'translation-cache.json');
  const fullCache = JSON.parse(await readFile(cachePath, 'utf8'));
  const malformedCache = JSON.stringify({ schema: 1, revision: fullCache.revision, entries: fullCache.entries });
  await writeFile(cachePath, malformedCache);
  const corrupt = await state();
  assert.equal(evidenceFor(corrupt, first.id)?.translation, undefined, '整个缓存未通过校验时消费者不能仅凭 entry 字段展示译文');
  assert.equal(corrupt.signals.translationRevision, 0);
  const corruptData = await createStore(folder).getData();
  const corruptDerived = derive({ ...corruptData, now: Date.now(), account: 'thsottiaux' });
  assert.doesNotMatch(JSON.stringify(corruptDerived.signals), /明天将重置所有使用额度/);
  assert.equal(await readFile(cachePath, 'utf8'), malformedCache, '读取坏缓存不覆盖或重置额度');
  console.log('✓ 真实 HTTP：采集立即响应、后台翻译与修订刷新、网页/小程序/管理页缓存透传、429 保留英文通过');
} finally {
  child?.kill('SIGTERM');
  if (closed) await closed;
  await rm(folder, { recursive: true, force: true });
}
