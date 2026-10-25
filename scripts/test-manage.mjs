#!/usr/bin/env node
/** 人工更正账本、有效数据投影与匿名管理接口的隔离回归测试。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { createManualStore, MAX_MANUAL_HISTORY, MAX_MANUAL_STATE_BYTES,
  canonicalizeManualEntryTarget, projectManualData, validateManualEntry } from '../src/lib/manual-state.mjs';
import { createStore } from '../server/store.mjs';
import { handleManage } from '../server/manage.mjs';
import { analyzeTweet, detectSignals, latestEventMs } from '../src/lib/signals.mjs';
import { buildResetCalendar } from '../src/lib/reset-calendar.mjs';

const NOW = Date.parse('2026-10-23T07:10:00.000Z');
const DAY_ONE = {
  id: '2000000000000000001', text: 'Day 1/ Improvements begin.', created_at: '2026-10-05T06:00:00.000Z',
  account: 'thsottiaux', author_verified: true, foundVia: 'timeline-browser',
  url: 'https://x.com/thsottiaux/status/2000000000000000001',
};
const DAY17 = {
  id: '2113162277688070445',
  text: 'Day 17/ Bet you thought we forgot, but no, it’s reset day today.',
  created_at: '2026-10-22T06:55:22.000Z', account: 'thsottiaux', author_verified: true,
  foundVia: 'timeline-browser', url: 'https://x.com/thsottiaux/status/2113162277688070445',
};
const DAY17_REPLY = {
  id: '2113162413008884099', text: 'Lands tomorrow before 10am PST.', created_at: '2026-10-22T06:55:54.000Z',
  account: 'thsottiaux', author_verified: true, foundVia: 'with-replies',
  url: 'https://x.com/thsottiaux/status/2113162413008884099',
  inReplyTo: { ...DAY17, relation: 'reply', verified: true },
};
const DAY17_BRIDGE_REPLY = {
  id: '2113492502355562879', text: 'Landing is being handled.', created_at: '2026-10-23T04:47:00.000Z',
  account: 'thsottiaux', author_verified: true, foundVia: 'with-replies',
  url: 'https://x.com/thsottiaux/status/2113492502355562879',
  inReplyTo: { ...DAY17, relation: 'reply', verified: true },
};
const DAY18_REPLY_VIA_BRIDGE = {
  id: '2113492502355562880', text: 'Day 18/ A separate reset is tomorrow.', created_at: '2026-10-23T04:47:34.000Z',
  account: 'thsottiaux', author_verified: true, foundVia: 'with-replies',
  url: 'https://x.com/thsottiaux/status/2113492502355562880',
  inReplyTo: { ...DAY17_BRIDGE_REPLY, relation: 'reply', verified: true },
};
const DAY17_COMPLETE = {
  id: '2113162413008884101', text: 'Reset all propagated. Sweet dreams.',
  created_at: '2026-10-22T07:10:00.000Z', account: 'thsottiaux', author_verified: true,
  foundVia: 'with-replies', url: 'https://x.com/thsottiaux/status/2113162413008884101',
  inReplyTo: { ...DAY17, relation: 'reply', verified: true },
};
const DAY18 = {
  id: '2113492187770175603',
  text: 'Day 18/ Decisions API shipped. But yes… that’s a reset!',
  created_at: '2026-10-23T04:46:19.000Z', account: 'thsottiaux', author_verified: true,
  foundVia: 'timeline-browser', url: 'https://x.com/thsottiaux/status/2113492187770175603',
};
const DAY18_REPLY = {
  id: '2113492502355562875', text: 'Landing tomorrow before 10am PST together with a small ship.',
  created_at: '2026-10-23T04:47:34.000Z', account: 'thsottiaux', author_verified: true,
  foundVia: 'with-replies', url: 'https://x.com/thsottiaux/status/2113492502355562875',
  inReplyTo: { ...DAY18, relation: 'reply', verified: true },
};
const DAY18_SEPARATE_REPLY_TO_DAY17 = {
  id: '2113492502355562878', text: 'Day 18/ A separate reset is tomorrow.', created_at: '2026-10-23T04:47:34.000Z',
  account: 'thsottiaux', author_verified: true, foundVia: 'with-replies',
  url: 'https://x.com/thsottiaux/status/2113492502355562878',
  inReplyTo: { ...DAY17, relation: 'reply', verified: true },
};
const OTHER = {
  id: '2113000000000000000', text: 'A separate unrelated post.', created_at: '2026-10-21T10:00:00.000Z',
  account: 'thsottiaux', author_verified: true, foundVia: 'timeline-browser',
  url: 'https://x.com/thsottiaux/status/2113000000000000000',
};
const PAST_FULFILLED = {
  id: '2110000000000000001', text: 'A reset tomorrow at 10am PST.', created_at: '2026-10-05T06:00:00.000Z',
  account: 'thsottiaux', author_verified: true, foundVia: 'timeline-browser',
  url: 'https://x.com/thsottiaux/status/2110000000000000001',
};
const PAST_UNLISTED = {
  id: '2110000000000000002', text: 'A reset tomorrow at 10am PST.', created_at: '2026-10-06T06:00:00.000Z',
  account: 'thsottiaux', author_verified: true, foundVia: 'timeline-browser',
  url: 'https://x.com/thsottiaux/status/2110000000000000002',
};
const PAST_RETIRED = {
  id: '2110000000000000003', text: 'A reset tomorrow at 10am PST.', created_at: '2026-10-07T06:00:00.000Z',
  account: 'thsottiaux', author_verified: true, foundVia: 'timeline-browser',
  url: 'https://x.com/thsottiaux/status/2110000000000000003',
};
const ORPHAN_COMPLETE = {
  id: '2110000000000000004', text: 'Reset all propagated. Sweet dreams.', created_at: '2026-10-20T06:00:00.000Z',
  account: 'thsottiaux', author_verified: true, foundVia: 'timeline-browser',
  url: 'https://x.com/thsottiaux/status/2110000000000000004',
};
const PLAIN = {
  id: '2110000000000000005', text: 'A regular product update.', created_at: '2026-10-20T07:00:00.000Z',
  account: 'thsottiaux', author_verified: true, foundVia: 'timeline-browser',
  url: 'https://x.com/thsottiaux/status/2110000000000000005',
};
const RAW_RESETS = { records: [
  { id: 'day17-auto', type: 'reset', announced_at: '2026-10-22T07:00:00.000Z',
    text: DAY17.text, url: DAY17.url, attribution: 'x.com/thsottiaux', confirmation_urls: [DAY17.url] },
  { id: 'unrelated-event', type: 'credit', announced_at: '2026-10-21T12:00:00.000Z',
    text: 'Unrelated prior credit', url: 'https://codex-resets.com/event/other' },
] };
const RAW_TWEETS = { updated_at: '2026-10-23T07:01:24.525Z', tweets: [DAY_ONE, DAY17, DAY17_REPLY, DAY18, DAY18_REPLY, OTHER] };
const RAW_STATS = { generated_at: RAW_TWEETS.updated_at, stats: { total: 2 }, errors: [] };
const WINDOW_FROM = '2026-10-23T20:00:00+08:00';
const WINDOW_TO = '2026-10-23T22:00:00+08:00';
const PROGRAM_POST = {
  id: '2112000000000000000', text: 'Either we reset once or pause for the next 28 days.',
  created_at: '2026-10-04T20:00:00.000Z', account: 'thsottiaux', author_verified: true,
  foundVia: 'timeline-browser', url: 'https://x.com/thsottiaux/status/2112000000000000000',
};
const PROGRAM_ID = PROGRAM_POST.id;
const PROGRAM_SIGNALS = { program: { id: PROGRAM_ID, days: 28, announcedAt: PROGRAM_POST.created_at, url: PROGRAM_POST.url },
  forecasts: [], overdueForecasts: [], activeHints: [] };
let checks = 0, mutants = 0;

const sourcePaths = {
  manual: new URL('../src/lib/manual-state.mjs', import.meta.url),
  store: new URL('../server/store.mjs', import.meta.url),
  manage: new URL('../server/manage.mjs', import.meta.url),
  calendar: new URL('../src/lib/reset-calendar.mjs', import.meta.url),
};
const sourceSnapshots = {};
for (const [key, url] of Object.entries(sourcePaths)) {
  const source = await readFile(url, 'utf8');
  sourceSnapshots[key] = { url, source, hash: createHash('sha256').update(source).digest('hex') };
}

async function tempDir() { return mkdtemp(resolve(tmpdir(), 'tibo-manage-test-')); }
async function seed(folder, { resets = RAW_RESETS, tweets = RAW_TWEETS, statsFile = RAW_STATS } = {}) {
  await Promise.all([
    writeFile(resolve(folder, 'resets.json'), JSON.stringify(resets)),
    writeFile(resolve(folder, 'tweets.json'), JSON.stringify(tweets)),
    writeFile(resolve(folder, 'stats.json'), JSON.stringify(statsFile)),
  ]);
}
function legacyDay17Data() {
  const observation = { ...DAY17, accountObservation: {
    kind: 'restored', source: 'maintainer-account', precision: 'approximate-minute',
    observed_at: '2026-10-22T17:10:00.000Z', recorded_at: '2026-10-23T06:57:00.000Z', announcement_text: DAY17.text,
  } };
  return { updated_at: RAW_TWEETS.updated_at, tweets: [DAY_ONE, observation, DAY17_REPLY, DAY18, DAY18_REPLY] };
}
function saveEntry(patch = {}) {
  return {
    tweetId: DAY17.id, status: 'landed', title: 'Day 17 reset confirmed', note: 'Account restored around 01:10 Beijing.',
    occurredAt: '2026-10-22T17:10:00.000Z', eventType: 'reset', ...patch,
  };
}
function overlappingGroupEntries() {
  return [
    { id: '20000000-0000-4000-8000-000000000017', tweetId: DAY17.id, status: 'landed',
      title: 'Day 17 landed', note: 'Earlier parent correction.', occurredAt: '2026-10-22T17:10:00.000Z', eventType: 'reset',
      createdAt: '2026-10-23T07:00:00.000Z', updatedAt: '2026-10-23T07:00:00.000Z' },
    { id: '20000000-0000-4000-8000-000000000018', tweetId: DAY17_REPLY.id, status: 'announced',
      title: 'Day 17 timing update', note: 'Later reply correction.', windowFrom: WINDOW_FROM, windowTo: WINDOW_TO,
      eventType: 'reset', createdAt: '2026-10-23T07:01:00.000Z', updatedAt: '2026-10-23T07:01:00.000Z' },
  ];
}
function assertMutation(condition, message) { assert.ok(condition, message); checks++; }

function responseHarness() {
  return {
    statusCode: 0, headers: {}, body: null,
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; },
    end(body = '') { this.body = typeof body === 'string' ? body : String(body); },
  };
}
async function requestManage(store, {
  method = 'GET', body = '', contentType = 'application/json', origin = undefined,
  host = 'localhost:8787', getState = undefined, now = NOW, account = 'thsottiaux', send = undefined,
  handler = handleManage, onSaved = undefined,
} = {}) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.headers = { host, ...(contentType ? { 'content-type': contentType } : {}), ...(origin ? { origin } : {}) };
  const res = responseHarness();
  await handler(req, res, { store, getState, onSaved, now, account, send });
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body || 'null') };
}

async function exerciseCurrentTweetStates(handler) {
  const folder = await tempDir();
  try {
    const bulkTweets = Array.from({ length: 205 }, (_, index) => {
      const id = String(2120000000000000000n + BigInt(index));
      return { id, text: 'A routine product update.', created_at: '2026-10-20T07:00:00.000Z',
        account: 'thsottiaux', author_verified: true, foundVia: 'timeline-browser',
        url: `https://x.com/thsottiaux/status/${id}` };
    });
    const tweets = [DAY_ONE, DAY17, DAY17_REPLY, DAY17_COMPLETE, DAY18, DAY18_REPLY, OTHER,
      PAST_FULFILLED, PAST_UNLISTED, PAST_RETIRED, ORPHAN_COMPLETE, PLAIN, ...bulkTweets];
    const pastRecord = {
      id: PAST_FULFILLED.id, type: 'reset', announced_at: '2026-10-06T19:00:00.000Z',
      first_confirmed_at: '2026-10-06T19:02:00.000Z', text: PAST_FULFILLED.text,
      url: PAST_FULFILLED.url, attribution: 'x.com/thsottiaux', confirmation_urls: [PAST_FULFILLED.url],
    };
    await seed(folder, {
      resets: { records: [...RAW_RESETS.records, pastRecord] },
      tweets: { ...RAW_TWEETS, tweets },
    });
    const store = createStore(folder);
    const saved = await store.manualStore.mutate({ revision: 0, action: 'save', account: 'thsottiaux', now: NOW,
      entry: { tweetId: DAY17.id, status: 'ignored', title: 'Day 17 ignored', note: 'Not a reset event.', eventType: 'reset' } });
    const getState = async () => ({ signals: {
      forecasts: [{ evidence: [{ id: DAY18.id }, { id: DAY18_REPLY.id }] }],
      overdueForecasts: [{ evidence: [{ id: PAST_UNLISTED.id }] }],
      activeHints: [{ id: OTHER.id }],
      // 旧线索仍留在档案里，不应伪装成当前线索。
      hints: [{ id: PAST_RETIRED.id }],
    } });
    const snapshot = await requestManage(store, { handler, getState });
    assert.equal(snapshot.status, 200);
    assert.equal(Object.keys(snapshot.body.tweetStates).length, tweets.length);
    const states = snapshot.body.tweetStates;
    assert.deepEqual(states[DAY17.id], {
      status: 'ignored', label: '已忽略', source: 'manual', entryId: saved.entry.id, note: 'Not a reset event.',
    });
    assert.equal(states[DAY17_REPLY.id].status, 'ignored');
    assert.equal(states[DAY17_REPLY.id].source, 'manual');
    assert.equal(states[DAY17_REPLY.id].entryId, saved.entry.id);
    assert.equal(states[DAY17_COMPLETE.id].status, 'ignored');
    assert.equal(states[DAY18.id].status, 'announced');
    assert.equal(states[DAY18.id].label, '预告待落地');
    assert.equal(states[DAY18_REPLY.id].status, 'announced');
    assert.equal(states[PAST_UNLISTED.id].status, 'announced');
    assert.equal(states[PAST_UNLISTED.id].label, '预告已过期，待核实');
    assert.equal(states[PAST_UNLISTED.id].source, 'automatic');
    assert.equal(analyzeTweet(PAST_FULFILLED, { now: NOW, account: 'thsottiaux' }).level, 'explicit');
    assert.equal(states[PAST_FULFILLED.id].status, 'landed');
    assert.equal(states[PAST_FULFILLED.id].source, 'automatic');
    assert.equal(states[PAST_FULFILLED.id].occurredAt, pastRecord.first_confirmed_at);
    assert.equal(states[OTHER.id].status, 'hint');
    assert.equal(states[ORPHAN_COMPLETE.id].status, 'none');
    assert.equal(states[ORPHAN_COMPLETE.id].label, '提及重置，待确认');
    assert.equal(states[PAST_RETIRED.id].status, 'none');
    assert.equal(states[PAST_RETIRED.id].label, '历史预告，非当前预告');
    assert.equal(states[PLAIN.id].status, 'none');
    assert.equal(states[PLAIN.id].label, '普通动态');
    assert.equal(states[bulkTweets.at(-1).id].label, '普通动态');
    checks += 25;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

async function importMutant(key, replacements) {
  const snapshot = sourceSnapshots[key];
  let source = snapshot.source;
  for (const [from, to] of replacements) {
    assert.ok(source.includes(from), `${key} mutant anchor exists: ${from}`);
    source = source.replace(from, to);
  }
  source = source.replace(/from (['"])(\.[^'"]+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, snapshot.url).href}${quote}`);
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  mutants++;
  return module;
}

async function expectMutantRejected(name, key, replacements, exercise) {
  const mutant = await importMutant(key, replacements);
  let rejected = false;
  try { await exercise(mutant); } catch { rejected = true; }
  assert.ok(rejected, `${name}: isolated source mutant must fail its behavior assertion`);
  console.log(`✓ ${name}: isolated mutant rejected`);
}
async function exerciseVerifiedGroupManage(handler) {
  const folder = await tempDir();
  try {
    await seed(folder);
    const store = createStore(folder);
    const parent = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787', handler,
      body: JSON.stringify({ revision: 0, action: 'save', entry: saveEntry() }) });
    assert.equal(parent.status, 200);
    const stableId = parent.body.entry.id;
    assert.equal(parent.body.entries.length, 1);

    const replyAnnounced = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787', handler,
      body: JSON.stringify({ revision: 1, action: 'save', entry: {
        tweetId: DAY17_REPLY.id, status: 'announced', title: 'Day 17 landing time update', note: 'Verified reply correction.',
        windowFrom: WINDOW_FROM, windowTo: WINDOW_TO, eventType: 'reset',
      } }) });
    assert.equal(replyAnnounced.status, 200);
    assert.equal(replyAnnounced.body.entry.id, stableId);
    assert.equal(replyAnnounced.body.entry.tweetId, DAY17.id);
    assert.equal(replyAnnounced.body.entries.length, 1);
    const announced = await store.getData({ now: NOW });
    assert.equal(announced.resets.records.some((record) => record.manualEntryId === stableId), false);
    assert.equal(announced.tweets.tweets.find((tweet) => tweet.id === DAY17.id).manualDecision.status, 'announced');
    assert.equal(announced.tweets.tweets.find((tweet) => tweet.id === DAY17_REPLY.id).manualDecision.lead, false);

    const replyLanded = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787', handler,
      body: JSON.stringify({ revision: 2, action: 'save', entry: {
        tweetId: DAY17_REPLY.id, status: 'landed', title: 'Day 17 reset landed', note: 'Confirmed from the reply.',
        occurredAt: '2026-10-23T05:00:00.000Z', eventType: 'reset',
      } }) });
    assert.equal(replyLanded.status, 200);
    assert.equal(replyLanded.body.entry.id, stableId);
    assert.equal(replyLanded.body.entry.tweetId, DAY17.id);
    assert.equal(replyLanded.body.entries.length, 1);
    const landed = await store.getData({ now: NOW });
    assert.equal(landed.resets.records.filter((record) => record.manualEntryId === stableId).length, 1);
    assert.equal(landed.resets.records.some((record) => record.id === 'day17-auto'), false);
    assert.equal(landed.tweets.tweets.find((tweet) => tweet.id === DAY17.id).manualDecision.status, 'landed');
    assert.equal(landed.tweets.tweets.find((tweet) => tweet.id === DAY17_REPLY.id).manualDecision.lead, false);

    const withdrawn = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787', handler,
      body: JSON.stringify({ revision: 3, action: 'withdraw', id: stableId }) });
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.body.entries.length, 0);
    const resaved = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787', handler,
      body: JSON.stringify({ revision: 4, action: 'save', entry: {
        tweetId: DAY17_REPLY.id, status: 'landed', title: 'Day 17 reset landed again', note: 'Saved after withdrawal.',
        occurredAt: '2026-10-23T05:00:00.000Z', eventType: 'reset',
      } }) });
    assert.equal(resaved.status, 200);
    assert.equal(resaved.body.entries.length, 1);
    const finalData = await store.getData({ now: NOW });
    assert.equal(finalData.resets.records.filter((record) => record.manualEntryId === resaved.body.entry.id).length, 1);
    assert.equal(finalData.resets.records.some((record) => record.id === 'day17-auto'), false);
    checks += 23;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

// 校验应拒绝无时区时间、非法状态、跨站来源和非规范链接。
assert.throws(() => validateManualEntry({ ...saveEntry(), occurredAt: '2026-10-22T17:10:00' }, { now: NOW })); checks++;
assert.throws(() => validateManualEntry({ ...saveEntry(), occurredAt: '2026-10-24T17:10:00Z' }, { now: NOW })); checks++;
assert.throws(() => validateManualEntry({ ...saveEntry(), sourceUrl: 'https://evil.example/thsottiaux/status/1' }, { now: NOW })); checks++;
assert.throws(() => validateManualEntry({ ...saveEntry(), status: 'announced' }, { now: NOW })); checks++;
assert.throws(() => validateManualEntry({ ...saveEntry(), status: 'announced', occurredAt: undefined,
  windowFrom: '2026-10-01T00:00:00Z', windowTo: '2026-10-16T00:00:00Z' }, { now: NOW })); checks++;
assertMutation(validateManualEntry({ status: 'announced', title: 'Reset expected', windowFrom: WINDOW_FROM,
  windowTo: WINDOW_TO, eventType: 'reset' }, { now: NOW }).windowFrom === '2026-10-23T12:00:00.000Z',
  'offset ISO timestamps normalize to UTC');

await expectMutantRejected('landed 必须有实际时刻的校验反例', 'manual', [
  ["if (value.status === 'landed' && !occurredAt) throw manualError('MANUAL_INVALID', 'landed 状态必须填写 occurredAt');",
    "if (false) throw manualError('MANUAL_INVALID', 'landed 状态必须填写 occurredAt');"],
], async (module) => assert.throws(() => module.validateManualEntry({ status: 'landed', title: 'Reset', eventType: 'reset' }, { now: NOW })));
await expectMutantRejected('X 来源地址必须规范的校验反例', 'manual', [
  ['!expectedPath.test(parsed.pathname)', 'false'],
], async (module) => assert.throws(() => module.validateManualEntry({ status: 'announced', title: 'Reset',
  sourceUrl: 'https://x.com/another-account/status/1' }, { now: NOW })));

// 账本串行写入、乐观冲突、同目标更新与带审计撤销。
{
  const folder = await tempDir();
  try {
    const ledger = createManualStore(folder);
    assert.deepEqual(await ledger.get(), { revision: 0, entries: [], history: [] }); checks++;
    const races = await Promise.allSettled([
      ledger.mutate({ revision: 0, action: 'save', entry: saveEntry(), now: NOW }),
      ledger.mutate({ revision: 0, action: 'save', entry: saveEntry({ tweetId: DAY18.id, title: 'Day 18' }), now: NOW }),
    ]);
    const saved = races.find((result) => result.status === 'fulfilled');
    const rejected = races.find((result) => result.status === 'rejected');
    assert.ok(saved); assert.equal(rejected.reason.code, 'REVISION_CONFLICT'); checks += 2;
    const originalId = saved.value.entry.id;
    const current = await ledger.get();
    assert.equal(current.entries.length, 1); checks++;
    const target = current.entries[0].tweetId;
    const updated = await ledger.mutate({ revision: current.revision, action: 'save',
      entry: saveEntry({ tweetId: target, title: 'Corrected title' }), now: NOW + 1000 });
    assert.equal(updated.entries.length, 1); assert.equal(updated.entry.id, originalId);
    assert.equal(updated.entry.title, 'Corrected title'); assert.equal(updated.history.length, 2); checks += 4;
    const withdrawn = await ledger.mutate({ revision: updated.revision, action: 'withdraw', id: originalId, now: NOW + 2000 });
    assert.equal(withdrawn.entries.length, 0); assert.equal(withdrawn.revision, 3);
    assert.equal(withdrawn.history.at(-1).action, 'withdraw'); assert.equal(withdrawn.history.at(-1).after, null); checks += 4;
    assert.deepEqual(await createManualStore(folder).get(), { revision: 3, entries: [], history: withdrawn.history }); checks++;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

await expectMutantRejected('revision 冲突阻止旧编辑覆盖新状态', 'manual', [
  ['if (change.revision !== current.revision) {', 'if (false) {'],
], async (module) => {
  const folder = await tempDir();
  try {
    const ledger = module.createManualStore(folder);
    await ledger.mutate({ revision: 0, action: 'save', entry: saveEntry(), now: NOW });
    await assert.rejects(ledger.mutate({ revision: 0, action: 'save', entry: saveEntry({ title: 'Stale overwrite' }), now: NOW + 1 }),
      (error) => error.code === 'REVISION_CONFLICT');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

// 采集文件可整体替换；独立账本应保留，投影不得改写原始输入。
{
  const folder = await tempDir();
  try {
    await seed(folder);
    const store = createStore(folder, { account: 'thsottiaux' });
    await store.manualStore.mutate({ revision: 0, action: 'save', entry: saveEntry(), now: NOW });
    const before = await store.getRawData();
    const snapshot = JSON.stringify(before);
    const effective = await store.getData({ now: NOW });
    assert.equal(effective.tweets.manualRevision, 1); assert.equal(effective.resets.records.filter((r) => r.manualEntryId).length, 1); checks += 2;
    assert.equal(JSON.stringify(before), snapshot); checks++;
    before.tweets.tweets[0].text = 'mutated caller copy';
    assert.equal((await store.getRawData()).tweets.tweets[0].text, DAY_ONE.text); checks++;
    await seed(folder, { resets: { records: [{ id: 'later-ingest', type: 'credit', announced_at: '2026-10-23T06:00:00Z' }] },
      tweets: { updated_at: '2026-10-23T07:20:00.000Z', tweets: [DAY18] }, statsFile: RAW_STATS });
    const afterIngest = await createStore(folder).getData({ now: NOW });
    assert.equal(afterIngest.tweets.manualRevision, 1);
    assert.ok(afterIngest.resets.records.some((record) => record.manualEntryId));
    assert.ok(afterIngest.resets.records.some((record) => record.id === 'later-ingest'));
    assert.equal(afterIngest.tweets.updated_at, '2026-10-23T07:20:00.000Z'); checks += 4;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

await expectMutantRejected('store 返回副本，不允许调用方改写 mtime 缓存', 'store', [
  ['resets: JSON.parse(JSON.stringify(resets)),', 'resets,'],
], async (module) => {
  const folder = await tempDir();
  try {
    await seed(folder);
    const store = module.createStore(folder);
    const data = await store.getRawData();
    data.resets.records[0].text = 'caller mutation';
    assert.equal((await store.getRawData()).resets.records[0].text, RAW_RESETS.records[0].text);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

// 损坏或超限的账本必须停止读取；历史与条目达到上限时不静默截断。
{
  const folder = await tempDir();
  try {
    await writeFile(resolve(folder, 'manual-state.json'), '{broken');
    await assert.rejects(createManualStore(folder).get(), (error) => error.code === 'MANUAL_STATE_CORRUPT'); checks++;
    await writeFile(resolve(folder, 'manual-state.json'), ' '.repeat(MAX_MANUAL_STATE_BYTES + 1));
    await assert.rejects(createManualStore(folder).get(), (error) => error.code === 'MANUAL_STATE_CORRUPT'); checks++;
  } finally { await rm(folder, { recursive: true, force: true }); }
}
{
  const folder = await tempDir();
  try {
    const id = '00000000-0000-4000-8000-000000000001';
    const history = Array.from({ length: MAX_MANUAL_HISTORY }, () => ({ action: 'withdraw', at: '2026-10-23T07:00:00.000Z', entryId: id, before: null, after: null }));
    await writeFile(resolve(folder, 'manual-state.json'), JSON.stringify({ revision: 0, entries: [], history }));
    await assert.rejects(createManualStore(folder).mutate({ revision: 0, action: 'save', entry: saveEntry(), now: NOW }),
      (error) => error.code === 'MANUAL_LIMIT');
    assert.equal((await createManualStore(folder).get()).history.length, MAX_MANUAL_HISTORY);
    assert.equal((await createManualStore(folder).get()).revision, 0); checks += 3;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

// 旧账号实测转换为普通重置记录；直接更正同一目标时不再显示旧记录。
{
  const observation = { ...DAY17, accountObservation: {
    kind: 'restored', source: 'maintainer-account', precision: 'approximate-minute',
    observed_at: '2026-10-22T17:10:00.000Z', recorded_at: '2026-10-23T06:57:00.000Z', announcement_text: DAY17.text,
  } };
  const rawTweets = { updated_at: RAW_TWEETS.updated_at, tweets: [DAY_ONE, observation, DAY17_REPLY, DAY18, DAY18_REPLY] };
  const base = projectManualData({ resets: RAW_RESETS, tweets: rawTweets, statsFile: RAW_STATS,
    manual: { revision: 0, entries: [], history: [] }, now: NOW });
  assert.ok(base.resets.records.some((record) => record.id === `manual-account-${DAY17.id}` &&
    record.announced_at === '2026-10-22T17:10:00.000Z' && record.type === 'reset' && record.attribution === 'manual'));
  assert.ok(base.tweets.tweets.every((tweet) => !Object.hasOwn(tweet, 'accountObservation')));
  assert.equal(base.tweets.tweets.find((tweet) => tweet.id === DAY17.id).manualDecision.lead, true);
  assert.equal(base.tweets.tweets.find((tweet) => tweet.id === DAY17_REPLY.id).manualDecision.lead, false);
  assert.ok(Object.hasOwn(rawTweets.tweets[1], 'accountObservation')); checks += 5;
  const day17Records = base.resets.records.filter((record) => record.id === `manual-account-${DAY17.id}`);
  const signals = detectSignals(base.tweets.tweets, { now: NOW,
    lastResetAt: latestEventMs(day17Records), account: 'thsottiaux' });
  const calendar = buildResetCalendar({ records: day17Records, tweets: base.tweets.tweets,
    signals: { ...signals, program: { days: 28, announcedAt: '2026-10-04T20:00:00.000Z' } },
    now: NOW, account: 'thsottiaux' });
  const day17Row = calendar.plan.rows.find((row) => row.day === 17);
  assert.equal(calendar.confirmedCount, 1);
  assert.equal(calendar.observedCount, 0);
  assert.equal(day17Row.status, 'confirmed'); assert.equal(day17Row.confirmedCount, 1);
  assert.equal(day17Row.observedCount, 0);
  assert.equal(calendar.plan.rows.find((row) => row.day === 18).status, 'pending'); checks += 6;
  const ignored = { id: '10000000-0000-4000-8000-000000000001', tweetId: DAY17.id, status: 'ignored',
    title: 'Not a reset', note: '', eventType: 'reset', createdAt: '2026-10-23T07:00:00.000Z', updatedAt: '2026-10-23T07:00:00.000Z' };
  const corrected = projectManualData({ resets: RAW_RESETS, tweets: rawTweets, statsFile: RAW_STATS,
    manual: { revision: 1, entries: [ignored], history: [] }, now: NOW });
  assert.ok(!corrected.resets.records.some((record) => record.id === `manual-account-${DAY17.id}`));
  assert.ok(!corrected.resets.records.some((record) => record.id === 'day17-auto'));
  const withdrawn = projectManualData({ resets: RAW_RESETS, tweets: rawTweets, statsFile: RAW_STATS,
    manual: { revision: 2, entries: [], history: [] }, now: NOW });
  assert.ok(withdrawn.resets.records.some((record) => record.id === `manual-account-${DAY17.id}`));
  assert.ok(!withdrawn.resets.records.some((record) => record.id === 'day17-auto')); checks += 4;
}

await expectMutantRejected('legacy 账号实测必须转成普通已到账计划日', 'manual', [
  ['effectiveTweet.manualDecision = manualDecision(entry, String(effectiveTweet.id) === observation.announcementId);',
    'effectiveTweet.manualDecision = undefined;'],
], async (module) => {
  const observation = { ...DAY17, accountObservation: {
    kind: 'restored', source: 'maintainer-account', precision: 'approximate-minute',
    observed_at: '2026-10-22T17:10:00.000Z', recorded_at: '2026-10-23T06:57:00.000Z', announcement_text: DAY17.text,
  } };
  const rawTweets = { tweets: [DAY_ONE, observation, DAY17_REPLY, DAY18, DAY18_REPLY] };
  const projected = module.projectManualData({ resets: RAW_RESETS, tweets: rawTweets, statsFile: RAW_STATS,
    manual: { revision: 0, entries: [], history: [] }, now: NOW });
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY17.id).manualDecision.status, 'landed');
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY17.id).manualDecision.lead, true);
  const signals = detectSignals(projected.tweets.tweets, { now: NOW,
    lastResetAt: latestEventMs(projected.resets.records), account: 'thsottiaux' });
  const calendar = buildResetCalendar({ records: projected.resets.records, tweets: projected.tweets.tweets,
    signals: { ...signals, program: { days: 28, announcedAt: '2026-10-04T20:00:00.000Z' } },
    now: NOW, account: 'thsottiaux' });
  assert.equal(calendar.plan.rows.find((row) => row.day === 17).status, 'confirmed');
});

// 已有公开完成帖时优先保留一条来源记录，不再叠加旧账号实测的合成记录。
{
  const observation = { ...DAY17, accountObservation: {
    kind: 'restored', source: 'maintainer-account', precision: 'approximate-minute',
    observed_at: '2026-10-22T17:10:00.000Z', recorded_at: '2026-10-23T06:57:00.000Z', announcement_text: DAY17.text,
  } };
  const completionRecord = { id: 'day17-public-completion', type: 'reset',
    announced_at: DAY17_COMPLETE.created_at, first_confirmed_at: DAY17_COMPLETE.created_at,
    text: DAY17_COMPLETE.text, url: DAY17_COMPLETE.url, attribution: 'x.com/thsottiaux',
    confirmation_urls: [DAY17_COMPLETE.url] };
  const rawTweets = { tweets: [DAY_ONE, observation, DAY17_REPLY, DAY17_COMPLETE, DAY18, DAY18_REPLY] };
  const projected = projectManualData({ resets: { records: [...RAW_RESETS.records, completionRecord] }, tweets: rawTweets,
    statsFile: RAW_STATS, manual: { revision: 0, entries: [], history: [] }, now: NOW });
  assert.equal(projected.resets.records.filter((record) =>
    record.id === completionRecord.id || record.id === `manual-account-${DAY17.id}`).length, 1);
  assert.ok(projected.resets.records.some((record) => record.id === completionRecord.id));
  assert.ok(!projected.resets.records.some((record) => record.id === 'day17-auto'));
  const day17Records = projected.resets.records.filter((record) => record.id === completionRecord.id);
  const signals = detectSignals(projected.tweets.tweets, { now: NOW,
    lastResetAt: latestEventMs(day17Records), account: 'thsottiaux' });
  const calendar = buildResetCalendar({ records: day17Records, tweets: projected.tweets.tweets,
    signals: { ...signals, program: { days: 28, announcedAt: '2026-10-04T20:00:00.000Z' } },
    now: NOW, account: 'thsottiaux' });
  assert.equal(calendar.confirmedCount, 1);
  assert.equal(calendar.observedCount, 0);
  assert.equal(calendar.plan.rows.find((row) => row.day === 17).status, 'confirmed'); checks += 5;
}

await expectMutantRejected('公开完成与 legacy 实测不能重复记入', 'manual', [
  ['if ([...ids].some((id) => legacySuppressedSourceIds.has(id))) {\n      return preservedPublicRecordIds.has(String(record.id));\n    }',
    'if (false) {\n      return preservedPublicRecordIds.has(String(record.id));\n    }'],
], async (module) => {
  const observation = { ...DAY17, accountObservation: {
    kind: 'restored', source: 'maintainer-account', precision: 'approximate-minute',
    observed_at: '2026-10-22T17:10:00.000Z', recorded_at: '2026-10-23T06:57:00.000Z', announcement_text: DAY17.text,
  } };
  const completionRecord = { id: 'day17-public-completion', type: 'reset',
    announced_at: DAY17_COMPLETE.created_at, first_confirmed_at: DAY17_COMPLETE.created_at,
    text: DAY17_COMPLETE.text, url: DAY17_COMPLETE.url, confirmation_urls: [DAY17_COMPLETE.url] };
  const rawTweets = { tweets: [DAY_ONE, observation, DAY17_REPLY, DAY17_COMPLETE, DAY18, DAY18_REPLY] };
  const projected = module.projectManualData({ resets: { records: [...RAW_RESETS.records, completionRecord] }, tweets: rawTweets,
    statsFile: RAW_STATS, manual: { revision: 0, entries: [], history: [] }, now: NOW });
  assert.ok(!projected.resets.records.some((record) => record.id === 'day17-auto'));
  const day17Records = projected.resets.records.filter((record) =>
    record.id === completionRecord.id || record.id === `manual-account-${DAY17.id}`);
  const signals = detectSignals(projected.tweets.tweets, { now: NOW,
    lastResetAt: latestEventMs(day17Records), account: 'thsottiaux' });
  const calendar = buildResetCalendar({ records: day17Records, tweets: projected.tweets.tweets,
    signals: { ...signals, program: { days: 28, announcedAt: '2026-10-04T20:00:00.000Z' } },
    now: NOW, account: 'thsottiaux' });
  assert.equal(calendar.confirmedCount, 1);
});

await expectMutantRejected('有效账号观测必须回到普通到账记录', 'manual', [
  ['const observation = readAccountObservation(tweet, { now: nowMs, account: sourceAccount });', 'const observation = null;'],
], async (module) => {
  const observation = { ...DAY17, accountObservation: {
    kind: 'restored', source: 'maintainer-account', precision: 'approximate-minute',
    observed_at: '2026-10-22T17:10:00.000Z', recorded_at: '2026-10-23T06:57:00.000Z', announcement_text: DAY17.text,
  } };
  const projected = module.projectManualData({ resets: RAW_RESETS, tweets: { updated_at: RAW_TWEETS.updated_at, tweets: [observation] },
    statsFile: RAW_STATS, manual: { revision: 0, entries: [], history: [] }, now: NOW });
  assert.ok(projected.resets.records.some((record) => record.id === `manual-account-${DAY17.id}`));
});

// 自我回复组必须经过详情页核验；更正只替换同一来源的自动记录。
{
  const landedEntry = { id: '20000000-0000-4000-8000-000000000001', ...saveEntry(),
    createdAt: '2026-10-23T07:00:00.000Z', updatedAt: '2026-10-23T07:00:00.000Z' };
  const projected = projectManualData({ resets: RAW_RESETS, tweets: RAW_TWEETS, statsFile: RAW_STATS,
    manual: { revision: 1, entries: [landedEntry], history: [] }, now: NOW });
  assert.ok(!projected.resets.records.some((record) => record.id === 'day17-auto'));
  assert.ok(projected.resets.records.some((record) => record.id === 'unrelated-event'));
  assert.ok(projected.resets.records.some((record) => record.manualEntryId === landedEntry.id && record.type === 'reset'));
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY17.id).manualDecision.lead, true);
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY17_REPLY.id).manualDecision.lead, false);
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === OTHER.id).manualDecision, undefined); checks += 6;

  const signals = detectSignals(projected.tweets.tweets, { now: NOW,
    lastResetAt: latestEventMs(projected.resets.records), account: 'thsottiaux' });
  assert.equal(signals.forecasts.length, 1);
  assert.deepEqual(signals.forecasts[0].evidence.map((item) => item.id).sort(), [DAY18.id, DAY18_REPLY.id].sort());
  const calendar = buildResetCalendar({ records: projected.resets.records, tweets: projected.tweets.tweets,
    signals: { ...signals, program: { days: 28, announcedAt: '2026-10-04T20:00:00.000Z' } },
    now: NOW, account: 'thsottiaux' });
  assert.equal(calendar.plan.rows.find((row) => row.day === 17).status, 'confirmed');
  assert.equal(calendar.plan.rows.find((row) => row.day === 18).status, 'pending'); checks += 4;
}

// 明确不同 Day 编号即使存在 verified self-reply，也不能把下一天的新事件并进前一天更正。
{
  const entry = { id: '20000000-0000-4000-8000-000000000001', ...saveEntry(),
    createdAt: '2026-10-23T07:00:00.000Z', updatedAt: '2026-10-23T07:00:00.000Z' };
  const tweets = [DAY17, DAY17_REPLY, DAY18_SEPARATE_REPLY_TO_DAY17];
  const projected = projectManualData({ resets: RAW_RESETS, tweets: { tweets }, statsFile: RAW_STATS,
    manual: { revision: 1, entries: [entry], history: [] }, now: NOW });
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY17.id).manualDecision.status, 'landed');
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY17_REPLY.id).manualDecision.status, 'landed');
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY18_SEPARATE_REPLY_TO_DAY17.id).manualDecision, undefined);
  assert.notEqual(analyzeTweet(projected.tweets.tweets.find((tweet) => tweet.id === DAY18_SEPARATE_REPLY_TO_DAY17.id),
    { now: NOW, account: 'thsottiaux' }).level, 'occurred');
  const separateTarget = canonicalizeManualEntryTarget({ tweetId: DAY18_SEPARATE_REPLY_TO_DAY17.id },
    { resets: RAW_RESETS, tweets: { tweets }, account: 'thsottiaux' });
  assert.equal(separateTarget.entry.tweetId, DAY18_SEPARATE_REPLY_TO_DAY17.id);
  assert.deepEqual(separateTarget.groupTweetIds, [DAY18_SEPARATE_REPLY_TO_DAY17.id]); checks += 6;
}
await expectMutantRejected('不同 Day N 的 verified 回复必须保留为独立事件', 'manual', [
  ['return parentDay === null || childDay === parentDay;', 'return true;'],
], async (module) => {
  const entry = { id: '20000000-0000-4000-8000-000000000001', ...saveEntry(),
    createdAt: '2026-10-23T07:00:00.000Z', updatedAt: '2026-10-23T07:00:00.000Z' };
  const tweets = [DAY17, DAY17_REPLY, DAY18_SEPARATE_REPLY_TO_DAY17];
  const projected = module.projectManualData({ resets: RAW_RESETS, tweets: { tweets }, statsFile: RAW_STATS,
    manual: { revision: 1, entries: [entry], history: [] }, now: NOW });
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY18_SEPARATE_REPLY_TO_DAY17.id).manualDecision, undefined);
});

// 无编号回复桥接 Day17 与 Day18 时，最近上游编号仍须切开两个事件，且选取起点不改变分组。
{
  const tweets = [DAY17, DAY17_BRIDGE_REPLY, DAY18_REPLY_VIA_BRIDGE];
  const input = { resets: RAW_RESETS, tweets: { tweets }, account: 'thsottiaux' };
  const rootGroup = canonicalizeManualEntryTarget({ tweetId: DAY17.id }, input);
  const bridgeGroup = canonicalizeManualEntryTarget({ tweetId: DAY17_BRIDGE_REPLY.id }, input);
  const nextDayGroup = canonicalizeManualEntryTarget({ tweetId: DAY18_REPLY_VIA_BRIDGE.id }, input);
  const sameDayIds = [DAY17.id, DAY17_BRIDGE_REPLY.id].sort();
  assert.deepEqual(rootGroup.groupTweetIds, sameDayIds);
  assert.deepEqual(bridgeGroup.groupTweetIds, sameDayIds);
  assert.equal(rootGroup.entry.tweetId, DAY17.id);
  assert.equal(bridgeGroup.entry.tweetId, DAY17.id);
  assert.deepEqual(nextDayGroup.groupTweetIds, [DAY18_REPLY_VIA_BRIDGE.id]);
  assert.equal(nextDayGroup.entry.tweetId, DAY18_REPLY_VIA_BRIDGE.id);

  const entry = { id: '20000000-0000-4000-8000-000000000001', ...saveEntry(),
    createdAt: '2026-10-23T07:00:00.000Z', updatedAt: '2026-10-23T07:00:00.000Z' };
  const projected = projectManualData({ resets: RAW_RESETS, tweets: { tweets }, statsFile: RAW_STATS,
    manual: { revision: 1, entries: [entry], history: [] }, now: NOW });
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY17.id).manualDecision.status, 'landed');
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY17_BRIDGE_REPLY.id).manualDecision.status, 'landed');
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY18_REPLY_VIA_BRIDGE.id).manualDecision, undefined);
  assert.notEqual(analyzeTweet(projected.tweets.tweets.find((tweet) => tweet.id === DAY18_REPLY_VIA_BRIDGE.id),
    { now: NOW, account: 'thsottiaux' }).level, 'occurred'); checks += 10;

  const day18Entry = { id: '20000000-0000-4000-8000-000000000018', tweetId: DAY18_REPLY_VIA_BRIDGE.id,
    status: 'announced', title: DAY18_REPLY_VIA_BRIDGE.text, note: 'Day 18 is a separate event.',
    windowFrom: WINDOW_FROM, windowTo: WINDOW_TO, eventType: 'reset',
    createdAt: '2026-10-23T07:01:00.000Z', updatedAt: '2026-10-23T07:01:00.000Z' };
  const day18Only = projectManualData({ resets: RAW_RESETS, tweets: { tweets }, statsFile: RAW_STATS,
    manual: { revision: 1, entries: [day18Entry], history: [] }, now: NOW });
  assert.equal(day18Only.resets.records.some((record) => record.id === 'day17-auto'), true);
  assert.equal(day18Only.tweets.tweets.find((tweet) => tweet.id === DAY17.id).manualDecision, undefined);
  assert.equal(day18Only.tweets.tweets.find((tweet) => tweet.id === DAY17_BRIDGE_REPLY.id).manualDecision, undefined);
  assert.equal(day18Only.tweets.tweets.find((tweet) => tweet.id === DAY18_REPLY_VIA_BRIDGE.id).manualDecision.status, 'announced');
  assert.equal(day18Only.tweets.tweets.find((tweet) => tweet.id === DAY18_REPLY_VIA_BRIDGE.id).manualDecision.lead, true);
  assert.equal(analyzeTweet(day18Only.tweets.tweets.find((tweet) => tweet.id === DAY18_REPLY_VIA_BRIDGE.id),
    { now: NOW, account: 'thsottiaux' }).level, 'explicit'); checks += 6;
}
await expectMutantRejected('Day 边界沿无编号 bridge 继承最近上游声明', 'manual', [
  ['if (!relation || !verifiedReplyKeepsNearestProgramDay(tweet, relation, candidates, account)) continue;',
    'if (!relation) continue;'],
], async (module) => {
  const tweets = [DAY17, DAY17_BRIDGE_REPLY, DAY18_REPLY_VIA_BRIDGE];
  const nextDayGroup = module.canonicalizeManualEntryTarget({ tweetId: DAY18_REPLY_VIA_BRIDGE.id },
    { resets: RAW_RESETS, tweets: { tweets }, account: 'thsottiaux' });
  assert.deepEqual(nextDayGroup.groupTweetIds, [DAY18_REPLY_VIA_BRIDGE.id]);
});

// 老账本里若有两条覆盖同一 verified group 的更正，按最后修改时间只应用一条。
{
  const entries = overlappingGroupEntries();
  const projected = projectManualData({ resets: RAW_RESETS, tweets: RAW_TWEETS, statsFile: RAW_STATS,
    manual: { revision: 2, entries, history: [] }, now: NOW });
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY17.id).manualDecision.status, 'announced');
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY17.id).manualDecision.lead, true);
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY17_REPLY.id).manualDecision.lead, false);
  assert.equal(projected.resets.records.some((record) => record.manualEntryId), false);
  assert.equal(projected.resets.records.some((record) => record.id === 'day17-auto'), false); checks += 5;
}
await expectMutantRejected('重叠历史更正按最后更新项确定胜者', 'manual', [
  ['Date.parse(b.entry.updatedAt) - Date.parse(a.entry.updatedAt)', 'Date.parse(a.entry.updatedAt) - Date.parse(b.entry.updatedAt)'],
], async (module) => {
  const projected = module.projectManualData({ resets: RAW_RESETS, tweets: RAW_TWEETS, statsFile: RAW_STATS,
    manual: { revision: 2, entries: overlappingGroupEntries(), history: [] }, now: NOW });
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY17.id).manualDecision.status, 'announced');
  assert.equal(projected.resets.records.some((record) => record.manualEntryId), false);
});

await expectMutantRejected('同一 verified self-reply 组只给主裁定帖 lead', 'manual', [
  ['manualDecision(entry, String(tweet.id) === linkedTweetId)', 'manualDecision(entry, true)'],
], async (module) => {
  const entry = { id: '20000000-0000-4000-8000-000000000001', ...saveEntry(),
    createdAt: '2026-10-23T07:00:00.000Z', updatedAt: '2026-10-23T07:00:00.000Z' };
  const projected = module.projectManualData({ resets: RAW_RESETS, tweets: RAW_TWEETS, statsFile: RAW_STATS,
    manual: { revision: 1, entries: [entry], history: [] }, now: NOW });
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === DAY17_REPLY.id).manualDecision.lead, false);
});
await expectMutantRejected('未核验上下文不得把相邻推文并成同组', 'manual', [
  ['parent?.verified !== true ||', 'false ||'],
], async (module) => {
  const fakeReply = { ...DAY17_REPLY, id: '2113162413008884100',
    url: 'https://x.com/thsottiaux/status/2113162413008884100',
    inReplyTo: { ...DAY17_REPLY.inReplyTo, verified: false } };
  const entry = { id: '20000000-0000-4000-8000-000000000001', ...saveEntry(),
    createdAt: '2026-10-23T07:00:00.000Z', updatedAt: '2026-10-23T07:00:00.000Z' };
  const projected = module.projectManualData({ resets: RAW_RESETS, tweets: { tweets: [DAY17, fakeReply] }, statsFile: RAW_STATS,
    manual: { revision: 1, entries: [entry], history: [] }, now: NOW });
  assert.equal(projected.tweets.tweets.find((tweet) => tweet.id === fakeReply.id).manualDecision, undefined);
});
await expectMutantRejected('手动纠正必须压过同来源的原始自动记录', 'manual', [
  ['if ([...ids].some((id) => suppressedSourceIds.has(id))) return false;', 'if (false) return false;'],
], async (module) => {
  const entry = { id: '20000000-0000-4000-8000-000000000001', ...saveEntry(),
    createdAt: '2026-10-23T07:00:00.000Z', updatedAt: '2026-10-23T07:00:00.000Z' };
  const projected = module.projectManualData({ resets: RAW_RESETS, tweets: RAW_TWEETS, statsFile: RAW_STATS,
    manual: { revision: 1, entries: [entry], history: [] }, now: NOW });
  assert.equal(projected.resets.records.filter((record) => record.url === DAY17.url).length, 1);
});

// 从根帖到账改为已验证回复预告，再改为到账，必须持续复用唯一账本项与唯一重置记录。
await exerciseVerifiedGroupManage(handleManage);
await expectMutantRejected('verified 会话的 API 更正统一归一到根帖条目', 'manage', [
  ['const canonical = canonicalizeManualEntryTarget(entry, { resets: raw.resets, tweets: raw.tweets, account });\n      entry = canonical.entry;',
    'const canonical = { entry, groupTweetIds: [] };\n      entry = canonical.entry;'],
], async (module) => exerciseVerifiedGroupManage(module.handleManage));

// 管理接口接受它自己 GET 所展示的合成记录 ID，并还原到底层的稳定账本目标。
{
  const folder = await tempDir();
  try {
    await seed(folder, { tweets: legacyDay17Data() });
    const store = createStore(folder);
    const listed = await requestManage(store);
    const legacyRecord = listed.body.records.find((record) => record.id === `manual-account-${DAY17.id}`);
    assert.ok(legacyRecord);
    const saved = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 0, action: 'save', entry: {
        recordId: legacyRecord.id, status: 'landed', title: 'Day 17 reset confirmed',
        occurredAt: '2026-10-22T17:10:00.000Z', eventType: 'reset',
      } }) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.entry.tweetId, DAY17.id);
    assert.equal(saved.body.entry.recordId, undefined);
    assert.equal((await store.getManualState()).entries.length, 1); checks += 5;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

await expectMutantRejected('legacy 合成记录 ID 规范化到原推文目标', 'manage', [
  ['if (record.manualAccountObservation === true) {', 'if (false) {'],
], async (module) => {
  const folder = await tempDir();
  try {
    await seed(folder, { tweets: legacyDay17Data() });
    const store = createStore(folder);
    const listed = await requestManage(store);
    const legacyRecord = listed.body.records.find((record) => record.id === `manual-account-${DAY17.id}`);
    const saved = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787', handler: module.handleManage,
      body: JSON.stringify({ revision: 0, action: 'save', entry: {
        recordId: legacyRecord.id, status: 'landed', title: 'Day 17 reset confirmed',
        occurredAt: '2026-10-22T17:10:00.000Z', eventType: 'reset',
      } }) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.entry.tweetId, DAY17.id);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

{
  const folder = await tempDir();
  try {
    await seed(folder);
    const store = createStore(folder);
    const original = await store.manualStore.mutate({ revision: 0, action: 'save', entry: saveEntry(), now: NOW });
    const edited = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 1, action: 'save', entry: {
        id: original.entry.id, recordId: `manual-${original.entry.id}`, status: 'landed',
        title: 'Edited through effective record ID', occurredAt: saveEntry().occurredAt, eventType: 'reset',
      } }) });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.entry.id, original.entry.id);
    assert.equal(edited.body.entry.tweetId, DAY17.id);
    assert.equal(edited.body.entry.recordId, undefined);
    assert.equal((await store.getManualState()).entries.length, 1); checks += 5;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

await expectMutantRejected('active manual 合成记录 ID 还原到底层目标而不递归', 'manage', [
  ['const sourceEntryId = record.manualEntryId;', 'const sourceEntryId = null;'],
], async (module) => {
  const folder = await tempDir();
  try {
    await seed(folder);
    const store = createStore(folder);
    const original = await store.manualStore.mutate({ revision: 0, action: 'save', entry: saveEntry(), now: NOW });
    const edited = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787', handler: module.handleManage,
      body: JSON.stringify({ revision: 1, action: 'save', entry: {
        id: original.entry.id, recordId: `manual-${original.entry.id}`, status: 'landed',
        title: 'Edited through effective record ID', occurredAt: saveEntry().occurredAt, eventType: 'reset',
      } }) });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.entry.tweetId, DAY17.id);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

// 无推文或原始记录的 landed 项也可由 GET 的合成 record ID 编辑回原 entry。
{
  const folder = await tempDir();
  try {
    await seed(folder);
    const store = createStore(folder);
    const original = await store.manualStore.mutate({ revision: 0, action: 'save',
      entry: { status: 'landed', title: 'Standalone reset', occurredAt: '2026-10-20T10:00:00.000Z', eventType: 'reset' }, now: NOW });
    const listed = await requestManage(store);
    assert.ok(listed.body.records.some((record) => record.id === `manual-${original.entry.id}`));
    const edited = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 1, action: 'save', entry: {
        recordId: `manual-${original.entry.id}`, status: 'landed', title: 'Standalone reset edited',
        occurredAt: original.entry.occurredAt, eventType: 'reset',
      } }) });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.entry.id, original.entry.id);
    assert.equal(edited.body.entry.title, 'Standalone reset edited');
    assert.equal((await store.getManualState()).entries.length, 1); checks += 5;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

// 独立预告生成合成推文；忽略项不应进入线索或预测。
{
  const announced = { id: '30000000-0000-4000-8000-000000000001', status: 'announced', title: 'Manual reset announcement',
    note: 'Verified manually.', windowFrom: WINDOW_FROM, windowTo: WINDOW_TO, eventType: 'reset',
    createdAt: '2026-10-23T07:00:00.000Z', updatedAt: '2026-10-23T07:00:00.000Z' };
  const announcedData = projectManualData({ resets: RAW_RESETS, tweets: { updated_at: RAW_TWEETS.updated_at, tweets: [DAY_ONE] },
    statsFile: RAW_STATS, manual: { revision: 4, entries: [announced], history: [] }, now: NOW });
  const synthetic = announcedData.tweets.tweets.find((tweet) => tweet.id === `manual-${announced.id}`);
  assert.equal(synthetic.account, 'manual'); assert.equal(synthetic.author_verified, false);
  assert.equal(synthetic.foundVia, 'manual'); assert.equal(synthetic.manualDecision.lead, true);
  assert.equal(announcedData.tweets.manualRevision, 4); checks += 5;
  const observed = detectSignals(announcedData.tweets.tweets, { now: NOW, account: 'thsottiaux' });
  assert.ok(observed.forecasts.some((forecast) => forecast.evidence.some((item) => item.id === synthetic.id))); checks++;
  const ignoredEntry = { ...announced, id: '30000000-0000-4000-8000-000000000002', status: 'ignored' };
  const ignoredData = projectManualData({ resets: RAW_RESETS, tweets: { tweets: [DAY_ONE] }, statsFile: RAW_STATS,
    manual: { revision: 5, entries: [ignoredEntry], history: [] }, now: NOW });
  assert.ok(!ignoredData.tweets.tweets.some((tweet) => tweet.id === `manual-${ignoredEntry.id}`));
}

// 管理列表逐条展示当前状态：手动状态优先、到账记录胜过旧预告、只用当前预告/线索集合。
await exerciseCurrentTweetStates(handleManage);
await expectMutantRejected('手动状态也应用到 verified 组内非 lead 回复', 'manage', [
  ['if (manualStatus) {', 'if (manualStatus && decision?.lead !== false) {'],
], async (module) => exerciseCurrentTweetStates(module.handleManage));
await expectMutantRejected('GET 状态映射覆盖全部推文而不截断到 200 条', 'manage', [
  ['for (const rawTweet of rawTweets) {', 'for (const rawTweet of rawTweets.slice(0, 200)) {'],
], async (module) => exerciseCurrentTweetStates(module.handleManage));
await expectMutantRejected('过期且未列入当前信号的显式旧预告不得标成待落地', 'manage', [
  ["? '历史预告，非当前预告'\n        : analysis.level === 'hint' ?", "? '预告待落地'\n        : analysis.level === 'hint' ?"],
], async (module) => exerciseCurrentTweetStates(module.handleManage));

async function exerciseProgramAssignment(handler) {
  const folder = await tempDir();
  try {
    const day17Completion = { ...DAY17_COMPLETE };
    const resets = { records: [...RAW_RESETS.records, { id: day17Completion.id, type: 'reset',
      announced_at: day17Completion.created_at, text: day17Completion.text, url: day17Completion.url,
      confirmation_urls: [day17Completion.url] }] };
    await seed(folder, { resets, tweets: { ...RAW_TWEETS, tweets: [...RAW_TWEETS.tweets, PROGRAM_POST, day17Completion] } });
    const store = createStore(folder);
    const getState = async () => ({ signals: PROGRAM_SIGNALS });
    const initial = await requestManage(store, { handler, getState });
    assert.equal(initial.body.programPlan.programId, PROGRAM_ID);
    assert.equal(initial.body.programPlan.days, 28);
    assert.equal(initial.body.programPlan.rows.length, 28);
    assert.equal(initial.body.programPlan.rows.find((row) => row.day === 17).status, 'confirmed');
    const callbackCalls = [];
    const saved = await requestManage(store, { method: 'POST', handler, getState, onSaved: async (detail) => {
      callbackCalls.push(detail);
      return { sent: 1, failed: 0 };
    }, origin: 'http://localhost:8787', body: JSON.stringify({ revision: 0, action: 'save', entry: {
      status: 'landed', title: 'Day 18 reset manually confirmed', occurredAt: '2026-10-23T05:00:00.000Z',
      eventType: 'reset', programId: PROGRAM_ID, programDay: 18,
    } }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.entry.programId, PROGRAM_ID);
    assert.equal(saved.body.entry.programDay, 18);
    assert.equal(saved.body.notification.sent, 1);
    assert.equal(callbackCalls.length, 1);
    const current = await requestManage(store, { handler, getState });
    assert.equal(current.body.programPlan.rows.find((row) => row.day === 17).status, 'confirmed');
    const day18 = current.body.programPlan.rows.find((row) => row.day === 18);
    assert.equal(day18.status, 'confirmed');
    const unassigned = await requestManage(store, { method: 'POST', handler, getState, origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 1, action: 'save', entry: { status: 'landed', title: 'Standalone, no day guess',
        occurredAt: '2026-10-23T05:05:00.000Z', eventType: 'credit' } }) });
    assert.equal(unassigned.status, 200);
    assert.equal(unassigned.body.entry.programDay, undefined);
    assert.equal((await requestManage(store, { handler, getState })).body.programPlan.rows.find((row) => row.day === 18).status, 'confirmed');
    assert.equal(callbackCalls.length, 1, '无计划归属到账仍保存，但回调仅由显式手动记录触发；本次未传回调');
    const duplicateDay = await requestManage(store, { method: 'POST', handler, getState, origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 2, action: 'save', entry: { status: 'landed', title: 'Duplicate day event',
        occurredAt: '2026-10-23T05:06:00.000Z', eventType: 'reset', programId: PROGRAM_ID, programDay: 18 } }) });
    assert.equal(duplicateDay.status, 409);
    checks += 13;

    const invalidId = await requestManage(store, { method: 'POST', handler, getState, origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 2, action: 'save', entry: { status: 'landed', title: 'Wrong program',
        occurredAt: '2026-10-23T05:06:00.000Z', eventType: 'reset', programId: '2112000000000009999', programDay: 19 } }) });
    assert.equal(invalidId.status, 422);
    const conflictDay = await requestManage(store, { method: 'POST', handler, getState, origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 2, action: 'save', entry: { tweetId: DAY18.id, status: 'landed', title: 'Conflict day',
        occurredAt: '2026-10-23T05:07:00.000Z', eventType: 'reset', programId: PROGRAM_ID, programDay: 17 } }) });
    assert.equal(conflictDay.status, 422);
    const expired = await requestManage(store, { method: 'POST', handler, getState, now: Date.parse('2026-11-02T00:00:00.000Z'),
      origin: 'http://localhost:8787', body: JSON.stringify({ revision: 2, action: 'save', entry: { status: 'landed',
        title: 'Expired program', occurredAt: '2026-11-01T23:00:00.000Z', eventType: 'reset', programId: PROGRAM_ID, programDay: 20 } }) });
    assert.equal(expired.status, 422);
    assert.throws(() => validateManualEntry({ status: 'landed', title: 'Partial program', occurredAt: '2026-10-23T05:08:00Z',
      eventType: 'reset', programId: PROGRAM_ID }, { now: NOW }));
    assert.throws(() => validateManualEntry({ status: 'landed', title: 'Bad day', occurredAt: '2026-10-23T05:08:00Z',
      eventType: 'reset', programId: PROGRAM_ID, programDay: 63 }, { now: NOW }));
    checks += 6;
    const notificationFailure = await requestManage(store, { method: 'POST', handler, getState, origin: 'http://localhost:8787',
      onSaved: async () => { throw new Error('mock transient notification failure'); },
      body: JSON.stringify({ revision: 2, action: 'save', entry: { status: 'landed', title: 'Persist before notification',
        occurredAt: '2026-10-23T05:09:00.000Z', eventType: 'reset', programId: PROGRAM_ID, programDay: 19 } }) });
    assert.equal(notificationFailure.status, 200);
    assert.equal(notificationFailure.body.notification.failed, 1);
    assert.equal((await store.manualStore.get()).revision, 3);
    checks += 3;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

async function exerciseNotificationConfirmation(handler) {
  const folder = await tempDir();
  try {
    await seed(folder, { tweets: { ...RAW_TWEETS, tweets: [...RAW_TWEETS.tweets, PROGRAM_POST] } });
    const store = createStore(folder), getState = async () => ({ signals: PROGRAM_SIGNALS });
    const announcedAt = Date.parse('2026-10-23T04:00:00.000Z');
    const landedAt = Date.parse('2026-10-23T05:30:00.000Z');
    const editedAt = Date.parse('2026-10-23T06:30:00.000Z');
    const callbackCalls = [];
    const onSaved = async (detail) => { callbackCalls.push(detail); return { sent: 0, failed: 0 }; };
    const announced = await requestManage(store, { method: 'POST', handler, getState, onSaved,
      now: announcedAt, origin: 'http://localhost:8787', body: JSON.stringify({ revision: 0, action: 'save', entry: {
        tweetId: DAY18.id, status: 'announced', title: 'Day 18 reset announced', note: 'Time window pending.',
        windowFrom: WINDOW_FROM, windowTo: WINDOW_TO, eventType: 'reset',
      } }) });
    assert.equal(announced.status, 200, JSON.stringify(announced.body));
    assert.equal(callbackCalls.length, 0, '预告状态不调用到账通知回调');

    const landed = await requestManage(store, { method: 'POST', handler, getState, onSaved,
      now: landedAt, origin: 'http://localhost:8787', body: JSON.stringify({ revision: 1, action: 'save', entry: {
        id: announced.body.entry.id, tweetId: DAY18.id, status: 'landed', title: 'Day 18 reset landed',
        note: 'First confirmed arrival.', occurredAt: '2026-10-23T04:50:00.000Z', eventType: 'reset',
      } }) });
    assert.equal(landed.status, 200, JSON.stringify(landed.body));
    assert.equal(callbackCalls.length, 1);
    assert.equal(callbackCalls[0].confirmedAt, new Date(landedAt).toISOString());
    assert.equal(callbackCalls[0].newConfirmation, true);
    assert.notEqual(callbackCalls[0].confirmedAt, landed.body.entry.createdAt,
      '首次到账确认时间来自 landed 历史，而不是此前创建预告的时间');

    const edited = await requestManage(store, { method: 'POST', handler, getState, onSaved,
      now: editedAt, origin: 'http://localhost:8787', body: JSON.stringify({ revision: 2, action: 'save', entry: {
        id: announced.body.entry.id, tweetId: DAY18.id, status: 'landed', title: 'Day 18 reset landed',
        note: 'Added program attribution after verification.', occurredAt: '2026-10-23T04:50:00.000Z',
        eventType: 'reset', programId: PROGRAM_ID, programDay: 18,
      } }) });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.entry.programDay, 18);
    assert.equal(callbackCalls.length, 2);
    assert.equal(callbackCalls[1].confirmedAt, new Date(landedAt).toISOString(),
      '到账备注/归属编辑不能覆盖首次 landed 时间');
    assert.equal(callbackCalls[1].newConfirmation, false,
      '已到账条目的后续编辑只能重试旧 pending，不是新到账确认');
    assert.equal(edited.body.entry.createdAt, announced.body.entry.createdAt);
    assert.equal(edited.body.entry.updatedAt, new Date(editedAt).toISOString());
    checks += 14;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

async function exerciseLegacyConfirmationFallback(handler) {
  const folder = await tempDir();
  try {
    await seed(folder);
    const store = createStore(folder);
    const createdAt = Date.parse('2026-10-23T05:10:00.000Z');
    const editedAt = Date.parse('2026-10-23T06:30:00.000Z');
    const created = await store.manualStore.mutate({ revision: 0, action: 'save', now: createdAt,
      entry: { tweetId: DAY18.id, status: 'landed', title: 'Legacy landed record',
        occurredAt: '2026-10-23T05:00:00.000Z', eventType: 'reset' } });
    const legacy = await store.manualStore.get();
    await writeFile(store.manualStore.path, JSON.stringify({ ...legacy, history: [] }), 'utf8');
    const callbackCalls = [];
    const edited = await requestManage(store, { method: 'POST', handler, onSaved: async (detail) => {
      callbackCalls.push(detail); return { sent: 0, failed: 0 };
    }, now: editedAt, origin: 'http://localhost:8787', body: JSON.stringify({ revision: 1, action: 'save', entry: {
      id: created.entry.id, tweetId: DAY18.id, status: 'landed', title: 'Legacy landed record corrected',
      note: 'Added missing note.', occurredAt: created.entry.occurredAt, eventType: 'reset',
    } }) });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(callbackCalls.length, 1);
    assert.equal(callbackCalls[0].confirmedAt, new Date(createdAt).toISOString(),
      '旧账本没有 landed 转换历史时回落到 createdAt');
    assert.equal(callbackCalls[0].newConfirmation, false);
    checks += 4;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

async function exerciseHistoricalProgramEdit(handler) {
  const folder = await tempDir();
  try {
    await seed(folder, { tweets: { ...RAW_TWEETS, tweets: [...RAW_TWEETS.tweets, PROGRAM_POST] } });
    const store = createStore(folder), getState = async () => ({ signals: PROGRAM_SIGNALS });
    const saved = await requestManage(store, { method: 'POST', handler, getState, origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 0, action: 'save', entry: { status: 'landed', title: 'Original Day 18 correction',
        occurredAt: '2026-10-23T05:00:00.000Z', eventType: 'reset', programId: PROGRAM_ID, programDay: 18 } }) });
    assert.equal(saved.status, 200);
    const expiredNow = Date.parse('2026-11-02T00:00:00.000Z');
    const edited = await requestManage(store, { method: 'POST', handler, getState, now: expiredNow, origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 1, action: 'save', entry: { id: saved.body.entry.id, status: 'landed',
        title: 'Edited after program expiry', occurredAt: '2026-10-23T05:00:00.000Z', eventType: 'reset',
        programId: PROGRAM_ID, programDay: 18 } }) });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.entry.programId, PROGRAM_ID);
    assert.equal(edited.body.entry.programDay, 18);
    assert.equal(edited.body.entry.title, 'Edited after program expiry');
    const afterExpiry = await requestManage(store, { handler, getState, now: expiredNow });
    assert.equal(afterExpiry.body.programPlan, null, '过期计划不再作为可选的新归属');
    assert.equal(afterExpiry.body.entries.find((entry) => entry.id === saved.body.entry.id)?.programDay, 18,
      '历史条目的原有活动日归属保留');
    const fakeHistorical = await requestManage(store, { method: 'POST', handler, getState, now: expiredNow,
      origin: 'http://localhost:8787', body: JSON.stringify({ revision: 2, action: 'save', entry: {
        status: 'landed', title: 'Unverified historical activity', occurredAt: '2026-10-23T05:00:00.000Z',
        eventType: 'reset', programId: PROGRAM_ID, programDay: 19 } }) });
    assert.equal(fakeHistorical.status, 422, '新条目不能伪造已过期活动归属');
    checks += 8;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

await exerciseProgramAssignment(handleManage);
await exerciseHistoricalProgramEdit(handleManage);
await exerciseNotificationConfirmation(handleManage);
await exerciseLegacyConfirmationFallback(handleManage);
await expectMutantRejected('到账确认时刻不能随 landed 条目后续 updatedAt 漂移', 'manage', [
  ['const confirmedAt = confirmations.length ? new Date(Math.min(...confirmations)).toISOString() : result.entry.createdAt;',
    'const confirmedAt = result.entry.updatedAt;'],
], async (module) => exerciseNotificationConfirmation(module.handleManage));
await expectMutantRejected('已到账条目的后续保存不能再次声明新到账确认', 'manage', [
  ['const newConfirmation = change?.entryId === result.entry.id && change.before?.status !== \'landed\';',
    'const newConfirmation = true;'],
], async (module) => exerciseNotificationConfirmation(module.handleManage));
await expectMutantRejected('过期计划只允许续编具有可信保存历史的同一活动日', 'manage', [
  ['return manualState.history.some(', 'return false && manualState.history.some('],
], async (module) => exerciseHistoricalProgramEdit(module.handleManage));
await expectMutantRejected('管理接口拒绝跨计划或无效计划日的到账归属', 'manage', [
  ['if (!entry.programId) return;', 'if (entry.programId) return;'],
], async (module) => {
  const folder = await tempDir();
  try {
    await seed(folder, { tweets: { ...RAW_TWEETS, tweets: [...RAW_TWEETS.tweets, PROGRAM_POST] } });
    const store = createStore(folder);
    const result = await requestManage(store, { method: 'POST', handler: module.handleManage, getState: async () => ({ signals: PROGRAM_SIGNALS }),
      origin: 'http://localhost:8787', body: JSON.stringify({ revision: 0, action: 'save', entry: {
        status: 'landed', title: 'Day 18 reset manually confirmed', occurredAt: '2026-10-23T05:00:00.000Z',
        eventType: 'reset', programId: PROGRAM_ID, programDay: 18,
      } }) });
    assert.equal(result.status, 422);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

// 匿名接口验证目标、同源写入、公开读取结构、版本冲突与敏感信息隔离。
{
  const folder = await tempDir();
  try {
    await seed(folder);
    await writeFile(resolve(folder, 'subscriptions.json'), JSON.stringify({ items: [{ openid: 'private-openid' }], secret: 'wx-private-secret' }));
    const store = createStore(folder);
    const getState = async () => ({ signals: { forecasts: [{ id: 'forecast-1' }], overdueForecasts: [] }, health: { secret: 'not-public' } });
    const cross = await requestManage(store, { method: 'POST', origin: 'https://evil.example', body: '{}', getState });
    assert.equal(cross.status, 403); checks++;
    const wrongContentType = await requestManage(store, { method: 'POST', contentType: 'text/plain', body: '{}', origin: 'http://localhost:8787' });
    assert.equal(wrongContentType.status, 415); checks++;
    const malformed = await requestManage(store, { method: 'POST', body: '{', origin: 'http://localhost:8787' });
    assert.equal(malformed.status, 400); checks++;
    const badId = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 0, action: 'save', entry: saveEntry({ tweetId: '9999999999999999999' }) }) });
    assert.equal(badId.status, 422); checks++;
    const early = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 0, action: 'save', entry: saveEntry({ occurredAt: '2026-10-22T06:00:00.000Z' }) }) });
    assert.equal(early.status, 422); checks++;
    const ignoredEarly = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 0, action: 'save', entry: saveEntry({ status: 'ignored', occurredAt: '2026-10-22T06:00:00.000Z' }) }) });
    assert.equal(ignoredEarly.status, 422); checks++;

    // 无凭据、无 Origin 的命令行写入与同源浏览器写入均可完成；公开访问是明确的产品边界。
    const saved = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 0, action: 'save', entry: saveEntry() }) });
    assert.equal(saved.status, 200); assert.equal(saved.body.revision, 1); assert.ok(saved.body.entry.id); checks += 3;
    const conflict = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 0, action: 'save', entry: saveEntry({ title: 'stale' }) }) });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.revision, 1); checks += 2;
    const snapshot = await requestManage(store, { getState });
    assert.equal(snapshot.status, 200); assert.equal(snapshot.body.dataUpdatedAt, RAW_TWEETS.updated_at);
    assert.equal(snapshot.body.revision, 1); assert.equal(snapshot.body.forecasts[0].id, 'forecast-1');
    assert.ok(snapshot.body.records.some((record) => record.manualEntryId === saved.body.entry.id));
    assert.ok(snapshot.body.tweets.some((tweet) => tweet.id === DAY17.id));
    assert.ok(!JSON.stringify(snapshot.body).includes('private-openid'));
    assert.ok(!JSON.stringify(snapshot.body).includes('wx-private-secret'));
    assert.ok(!JSON.stringify(snapshot.body).includes('not-public')); checks += 7;
    const withdrawn = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 1, action: 'withdraw', id: saved.body.entry.id }) });
    assert.equal(withdrawn.status, 200); assert.equal(withdrawn.body.revision, 2); checks += 2;
    const wrongMethod = await requestManage(store, { method: 'PUT' });
    assert.equal(wrongMethod.status, 405); checks++;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

await expectMutantRejected('Origin 必须与请求主机一致', 'manage', [
  ["if (req.method === 'POST' && !sameOriginHost(req)) return reply(403, { error: 'cross-origin write rejected' });",
    "if (false) return reply(403, { error: 'cross-origin write rejected' });"],
], async (module) => {
  const folder = await tempDir();
  try {
    await seed(folder);
    const store = createStore(folder);
    const req = Readable.from(['{}']); req.method = 'POST'; req.headers = { host: 'localhost:8787', origin: 'https://evil.example', 'content-type': 'application/json' };
    const res = responseHarness();
    await module.handleManage(req, res, { store, now: NOW });
    assert.equal(res.statusCode, 403);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
await expectMutantRejected('HTTP 请求体超过 32KB 被提前拒绝', 'manage', [
  ['if (size > MAX_BODY_BYTES) {', 'if (false) {'],
], async (module) => {
  const folder = await tempDir();
  try {
    await seed(folder);
    const store = createStore(folder);
    const large = JSON.stringify({ revision: 0, action: 'withdraw', id: '00000000-0000-4000-8000-000000000001', extra: 'x'.repeat(33_000) });
    const req = Readable.from([large]); req.method = 'POST'; req.headers = { host: 'localhost:8787', 'content-type': 'application/json' };
    const res = responseHarness();
    await module.handleManage(req, res, { store, now: NOW });
    assert.equal(res.statusCode, 413);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
await expectMutantRejected('任何状态填写落地时间都不得早于原帖发布时间', 'manage', [
  ['if (entry.occurredAt && publishedTweet) {', "if (entry.status === 'landed' && entry.occurredAt && publishedTweet) {"],
], async (module) => {
  const folder = await tempDir();
  try {
    await seed(folder);
    const store = createStore(folder);
    const result = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787', handler: module.handleManage,
      body: JSON.stringify({ revision: 0, action: 'save', entry: saveEntry({
        status: 'ignored', occurredAt: '2026-10-22T06:00:00.000Z',
      }) }) });
    assert.equal(result.status, 422);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

// 接口限制请求体大小，账本保留完整审计历史而不丢弃旧条目。
{
  const folder = await tempDir();
  try {
    await seed(folder);
    const store = createStore(folder);
    const oversized = await requestManage(store, { method: 'POST', origin: 'http://localhost:8787',
      body: JSON.stringify({ revision: 0, action: 'withdraw', id: '00000000-0000-4000-8000-000000000001', extra: 'x'.repeat(33_000) }) });
    assert.equal(oversized.status, 413); checks++;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

// 所有源码变异仅在隔离的 data 模块中执行；最后核对工作区源码哈希未变。
for (const { url, hash } of Object.values(sourceSnapshots)) {
  assert.equal(createHash('sha256').update(await readFile(url, 'utf8')).digest('hex'), hash);
}
console.log(`\n${checks} 项通过；${mutants} 个隔离源码变异被行为断言拦截，原文件 SHA-256 均未变化`);
