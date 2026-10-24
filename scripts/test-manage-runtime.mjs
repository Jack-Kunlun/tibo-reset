#!/usr/bin/env node
/** 在隔离数据目录验证匿名管理、实时派生、采集保护与撤销，不触碰运行数据或微信。 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { writeOgAsset } from '../server/og.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const file = new URL('../server/index.mjs', import.meta.url);
const source = await readFile(file, 'utf8');
const hash = (value) => createHash('sha256').update(value).digest('hex');
assert.match(source, /if \(result\.pendingCount > 0\) setImmediate/, '管理保存按全部持久 pending 判断是否需要异步 drain');
assert.doesNotMatch(source, /if \(result\.queued\) setImmediate/, '不能把本次新事件 queued 数当作全部 pending');
const wrongDrainGate = source.replace('if (result.pendingCount > 0) setImmediate', 'if (result.queued) setImmediate');
assert.notEqual(wrongDrainGate, source, '总 pending 与本次 queued 混用的隔离变异锚点存在');
assert.doesNotMatch(wrongDrainGate, /if \(result\.pendingCount > 0\) setImmediate/, '隔离变异会被管理保存 drain 条件断言发现');
const before = hash(source);
const now = Date.now();
const iso = (hours) => new Date(now + hours * 3600000).toISOString();
const tweet = { id: '90000001', account: 'thsottiaux', author_verified: true, foundVia: 'timeline-browser',
  created_at: iso(-2), text: 'We will reset all usage limits tomorrow.', url: 'https://x.com/thsottiaux/status/90000001' };

/**
 * 造一张**形状合法**的 og 卡片（1200×630 的 PNG）。
 *
 * ⚠ 为什么这个夹具是必需的（2026-10-25 修 CI 假红）：
 *
 * `server/index.mjs` 的 `getOgMeta()` 有一条守卫：一旦数据里有「人工修订过的记录」，
 * 就不输出 og:image —— 因为预绘制的卡片上只有自动采集的旧数字，给平台一张
 * 「对着旧图说新话」的卡片比不给更糟。
 *
 * 这条守卫有两个可能的写法：
 *   A（正确）：看**投影后**的数据里有没有 manual 记录 —— 旧反馈（accountObservation）
 *              也会被投影成 manual 记录，所以能拦住。
 *   B（错误）：只看**账本**（manual-state.json）里有几条 —— 账本被删了就漏过去。
 *
 * 反例测试要把 B 抓住，靠的就是「B 会让 og:image 重新出现」。而 og:image 出现的
 * 前提是**环境里确实有一张卡片**。原先卡片只存在于 `dist/og-image.png` ——
 * 那是**构建产物**，CI 上 `npm run test` 跑在 `node scripts/build.mjs` **之前**，
 * 且 `dist/` 不入库 ⇒ **CI 上那张图从来就不存在** ⇒ B 也输出不了 og:image
 * ⇒ 反例抓不住 ⇒ 断言报 `Missing expected rejection`（2026-10-24 实测，
 * Pages 因此从 9-21 起停更一个月）。
 *
 * 所以隔离环境自己备一张卡片（走 `data/og/` 这条**运行期推送**的通道，
 * 与线上真实路径一致），不再依赖构建产物。
 *
 * 卡片本体只需要形状合法：`decodeOgPng` 只看 PNG 签名与 IHDR 声明的宽高。
 */
function buildOgCardPng(width = 1200, height = 630) {
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor
  // 一整块同色像素（IDAT 只要求能解开；这里用 zlib 压一段空数据）
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) raw[y * (1 + width * 3)] = 0;
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function replay(serverText, probeOnly = false) {
  const folder = await mkdtemp(resolve(tmpdir(), 'tibo-manage-runtime-'));
  const reserve = createServer();
  await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port;
  await new Promise(r => reserve.close(r));
  const executable = serverText.replace("const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');", `const ROOT = ${JSON.stringify(root)};`)
    .replace(/from (['"])(\.[^'"]+)\1/g, (_, q, p) => `from ${q}${new URL(p, file).href}${q}`);
  const raw = { updated_at: iso(-1), tweets: [tweet] };
  const records = Array.from({ length: 24 }, (_, index) => ({ id: 'history-' + index, type: 'reset', announced_at: iso(-50 - index * 60 - index % 3 * 3) }));
  await Promise.all([
    writeFile(resolve(folder, 'server.mjs'), executable),
    writeFile(resolve(folder, 'tweets.json'), JSON.stringify(raw)),
    writeFile(resolve(folder, 'resets.json'), JSON.stringify({ records })),
    writeFile(resolve(folder, 'stats.json'), JSON.stringify({ generated_at: iso(-1), errors: [] })),
  ]);
  // 隔离环境自带一张 og 卡片（见 buildOgCardPng 上方的说明）。
  // 走 `data/og/` 这条运行期推送通道 —— 与线上真实路径一致，
  // 且不依赖 `dist/og-image.png`（那是构建产物，CI 上跑 test 时还不存在）。
  await writeOgAsset(folder, {
    png: buildOgCardPng(),
    description: '隔离环境自带的 og 卡片',
    builtAt: iso(-1),
  });
  const child = spawn(process.execPath, [resolve(folder, 'server.mjs')], { cwd: root,
    env: { ...process.env, DATA_DIR: folder, PORT: String(port), COLLECT_INTERVAL_MIN: '0', WX_APPID: '', WX_SECRET: '', SITE_URL: 'https://acceptance.example', INGEST_TOKEN: 'isolated-test-token' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(r => child.once('close', r));
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const request = async (path, data, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, data === undefined ? options : {
      method: 'POST', headers: { 'content-type': 'application/json', ...options.headers }, body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    let ready = false;
    for (let n = 0; n < 80; n++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; } } catch {} await pause(30); }
    assert.ok(ready, output.slice(-1500));
    const initial = await request('/api/manage');
    if (probeOnly) return initial;
    assert.equal(initial.status, 200, '同服务管理接口无需登录');
    const page = await fetch(`http://127.0.0.1:${port}/manage`);
    assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /观测数据管理/);
    const rawBytes = await readFile(resolve(folder, 'tweets.json'), 'utf8');
    await request('/api/state');
    const save = await request('/api/manage', { revision: 0, action: 'save', entry: {
      tweetId: tweet.id, status: 'landed', title: '额度重置已到账', occurredAt: iso(-0.5), eventType: 'reset' } });
    assert.equal(save.status, 200, JSON.stringify(save));
    assert.deepEqual(save.data.notification, { sent: 0, failed: 0, skipped: 'wechat-not-configured' },
      '已保存到账通过管理回调进入通知链路；隔离环境没有微信配置，因此不尝试外发');
    const changed = (await request('/api/state')).data;
    assert.equal(changed.chart.count, records.length + 1); assert.equal(changed.chart.lastAt, iso(-0.5));
    assert.equal(changed.signals.forecasts.length, 0); assert.equal(changed.signals.observedForecasts.length, 0);
    assert.equal(changed.dataUpdatedAt, raw.updated_at, '手动更新不冒充采集更新');
    assert.equal(changed.signals.manualRevision, 1);
    assert.equal(await readFile(resolve(folder, 'tweets.json'), 'utf8'), rawBytes, '不改写原始快照');
    const conflict = await request('/api/manage', { revision: 0, action: 'save', entry: { status: 'ignored', title: '过期', eventType: 'reset' } });
    assert.equal(conflict.status, 409, '旧页面不覆盖其他访客修改');
    const invalid = await request('/api/manage', { revision: 1, action: 'save', entry: { status: 'landed', title: '未来到账', occurredAt: iso(24), eventType: 'reset' } });
    assert.equal(invalid.status, 422);
    assert.equal((await request('/api/manage', { revision: 1, action: 'withdraw', id: 'none' }, { headers: { origin: 'https://other.example' } })).status, 403);
    const extra = await request('/api/manage', { revision: 1, action: 'save', entry: {
      status: 'announced', title: '手动补充一条预告', windowFrom: iso(0), windowTo: iso(8), eventType: 'reset' } });
    assert.equal(extra.status, 200);
    assert.equal(extra.data.notification, undefined, '预告保存不触发到账通知');
    const withExtra = (await request('/api/state')).data;
    assert.equal(withExtra.signals.forecasts.length, 1);
    assert.equal(withExtra.signals.forecasts[0].manual, true);
    assert.ok((await (await fetch(`http://127.0.0.1:${port}/`)).text()).includes('手动补录预告'), '手动预告应实时渲染：'+output.slice(-900));
    const removeExtra = await request('/api/manage', { revision: 2, action: 'withdraw', id: extra.data.entry.id });
    assert.equal(removeExtra.status, 200);
    const ledgerBefore = await readFile(resolve(folder, 'manual-state.json'), 'utf8');
    const ingested = await request('/api/ingest', { generatedAt: iso(0), resets: { records }, tweets: { ...raw, updated_at: iso(0) }, stats: { errors: [] } }, { headers: { authorization: 'Bearer isolated-test-token' } });
    assert.equal(ingested.status, 200, JSON.stringify(ingested)); assert.equal(ingested.data.status, 'accepted');
    assert.equal(await readFile(resolve(folder, 'manual-state.json'), 'utf8'), ledgerBefore, '下一轮采集不覆盖手动状态');
    assert.equal((await request('/api/state')).data.chart.count, records.length + 1);
    const current = (await request('/api/manage')).data;
    const withdrawn = await request('/api/manage', { revision: 3, action: 'withdraw', id: current.entries[0].id });
    assert.equal(withdrawn.status, 200);
    const restored = (await request('/api/state')).data;
    assert.equal(restored.chart.count, records.length); assert.equal(restored.signals.manualRevision, 4);
    assert.equal(restored.signals.forecasts.length, 1, '撤销后恢复原始自动预告');
    assert.equal((await request('/api/manage')).data.history.length, 4);
    assert.doesNotMatch(output, /推送完成/, '隔离验收没有发送微信通知');
    await rm(resolve(folder, 'manual-state.json'));
    await writeFile(resolve(folder, 'tweets.json'), JSON.stringify({ ...raw, tweets: [{ ...tweet, accountObservation: {
      kind: 'restored', source: 'maintainer-account', precision: 'approximate-minute',
      observed_at: iso(-0.6), recorded_at: iso(0), announcement_text: tweet.text,
    } }] }));
    const legacyPage = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(!/<meta property="og:image"/.test(legacyPage), '旧反馈转为到账且账本不存在时，也不能输出旧分享图');
    return initial;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed; await rm(folder, { recursive: true, force: true });
  }
}

await replay(source);
const brokenRoute = source.replace("url.pathname === '/api/manage'", "url.pathname === '/api/manage-disabled'");
assert.notEqual(brokenRoute, source);
assert.equal((await replay(brokenRoute, true)).status, 404, '隔离路由反例可发现管理入口未接入');
const notificationDisconnected = source.replace(/onSaved: async \(\{ entry, manualEntryId \}\) => \{[\s\S]*?\n      \},\n    \}\);/,
  "onSaved: async () => ({ sent: 0, failed: 0, skipped: 'no-template-id' }),\n    });");
assert.notEqual(notificationDisconnected, source);
await assert.rejects(replay(notificationDisconnected), /已保存到账通过管理回调进入通知链路/);
const brokenOg = source.replace('if ((await store.getData()).resets.records.some((record) => record.manual)) return null;', 'if ((await store.getManualState()).entries.length) return null;');
assert.notEqual(brokenOg, source);
await assert.rejects(replay(brokenOg), /也不能输出旧分享图/);
assert.equal(hash(await readFile(file)), before, '反例不改变实际源文件');
const subscribeUrl = new URL('../server/subscribe.mjs', import.meta.url);
const subscribeSource = await readFile(subscribeUrl, 'utf8');
async function notificationProbe(text, retractDuringSend) {
  const folder = await mkdtemp(resolve(tmpdir(), 'tibo-manage-notification-'));
  const record = { id: 'mock-only', type: 'reset', announced_at: iso(-0.5) };
  await writeFile(resolve(folder, 'resets.json'), JSON.stringify({ records: [record] }));
  const absolute = text.replace(/from (['"])(\.[^'"]+)\1/g, (_, q, p) => `from ${q}${new URL(p, subscribeUrl).href}${q}`);
  const module = await import('data:text/javascript;base64,' + Buffer.from(absolute).toString('base64'));
  const state = { last_event_at: iso(-3), items: [{ id: 'isolated', kind: 'landed', openid: 'mock-only', template_id: 'mock', created_at: iso(-2) }] };
  let calls = 0, sent = 0;
  try {
    const result = await module.notifyNewResets({ dataDir: folder,
      store: { notify: job => job(), update: fn => fn(state) },
      client: { configured: true, sendSubscribeMessage: async () => { sent++; } }, templateId: 'mock',
      getRecords: async () => retractDuringSend && calls++ === 0 ? [record] : [],
    });
    return { result, sent };
  } finally { await rm(folder, { recursive: true, force: true }); }
}
assert.equal((await notificationProbe(subscribeSource, false)).result.skipped, 'no-resets');
assert.equal((await notificationProbe(subscribeSource, true)).sent, 0, '发送前修订排除后不消费授权');
const initialGateDisabled = subscribeSource.replace('const records = getRecords ? await getRecords() : ', 'const records = ');
assert.notEqual(initialGateDisabled, subscribeSource);
assert.equal((await notificationProbe(initialGateDisabled, false)).result.candidates, 1, '旧原始数据反例会错误创建候选');
const finalGateDisabled = subscribeSource.replace(`currentRecords = getNotificationRecords ? await getNotificationRecords() :
          (getRecords ? await getRecords() : JSON.parse(await readFile(resolve(dataDir, 'resets.json'), 'utf8')).records ?? []);`, 'currentRecords = records;');
assert.notEqual(finalGateDisabled, subscribeSource);
assert.equal((await notificationProbe(finalGateDisabled, true)).sent, 1, '关闭发送前复核的反例会向 mock 误发送');
assert.equal(hash(await readFile(subscribeUrl)), hash(subscribeSource));
console.log('✓ 管理页同服务匿名访问、到账同步、修订冲突、校验、采集保护与撤销通过；隔离路由反例及源码哈希通过');
