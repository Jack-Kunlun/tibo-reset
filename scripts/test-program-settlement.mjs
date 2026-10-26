#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import * as calendarModule from '../src/lib/reset-calendar.mjs';
import * as manualModule from '../src/lib/manual-state.mjs';
import * as signalsModule from '../src/lib/signals.mjs';
import { createStore } from '../server/store.mjs';
import { handleManage } from '../server/manage.mjs';
import { mergeTweetBatch } from '../src/lib/collect.mjs';

const account = 'thsottiaux';
const programId = '190';
const now = Date.parse('2026-10-26T08:00:00Z');
const tweet = (id, created_at, text, extra = {}) => ({ id, account, created_at, text,
  url: `https://x.com/${account}/status/${id}`, author_verified: true, foundVia: 'timeline-browser', ...extra });
const first = tweet('200', '2026-10-05T08:00:00Z', 'Day 1/ Improvements');
const program = { id: programId, days: 28, announcedAt: '2026-10-04T20:00:00Z' };
const root = tweet('2113492187770175603', '2026-10-23T04:46:19Z',
  'Day 18/ Decisions API is GA, OpenResponses joined the Linux Foundation, we shipped some performance improvements and Uber is going all-in on codex & work. But yes… that’s a reset!');
const promise = tweet('2113492502355562875', '2026-10-23T04:47:34Z',
  'Landing tomorrow before 10am PST together with a small ship.', {
    inReplyTo: { ...root, relation: 'reply', verified: true, verificationSource: 'tweet-detail-api' }, foundVia: 'with-replies',
  });
const manualId = '00000000-0000-4000-8000-000000000018';
const arrival = { id: `manual-${manualId}`, manual: true, manualEntryId: manualId,
  type: 'reset', announced_at: '2026-10-23T17:45:00Z', text: '额度重置已到账' };
const base = (extra = {}) => ({ tweets: [first, root, promise], records: [arrival], signals: { program }, now, ...extra });
const row = (c, day = 18) => c.plan.rows.find(item => item.day === day);
const assignment = (c, id = arrival.id) => c.plan.eventAssignments.find(item => item.recordId === id);
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`✓ ${name}`); };
const modules = { calendar: calendarModule, manual: manualModule, signals: signalsModule };
const sources = {};
for (const [name, relative] of Object.entries({ calendar: '../src/lib/reset-calendar.mjs',
  manual: '../src/lib/manual-state.mjs', signals: '../src/lib/signals.mjs' })) {
  const url = new URL(relative, import.meta.url);
  sources[name] = { url, text: await readFile(url, 'utf8') };
}
const sha = text => createHash('sha256').update(text).digest('hex');
async function mutate(name, from, to) {
  const source = sources[name];
  assert.ok(source.text.includes(from), `变异锚点存在：${from}`);
  const text = source.text.replace(from, to).replace(/from (['"])(\.[^'"]+)\1/g,
    (_, quote, relative) => `from ${quote}${new URL(relative, source.url).href}${quote}`);
  return import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
}

const cases = [
  ['独立到账跨北京时间日期，按明确截止窗口自动归 Day 18', 'calendar', m => {
    const c = m.buildResetCalendar(base());
    assert.equal(row(c).status, 'mixed'); assert.equal(row(c).confirmedCount, 1);
    assert.equal(assignment(c).source, 'announcement-window');
  }, 'assignUnlinkedProgramEvents({ events, posts, trusted, allTweets, account, programId });', ''],
  ['两个活动日的窗口重叠时不猜测归属', 'calendar', m => {
    const other = tweet('900', '2026-10-23T04:50:00Z', 'Day 19/ It’s reset day today.');
    const otherPromise = tweet('901', '2026-10-23T04:51:00Z', promise.text, { inReplyTo: { ...other, relation: 'reply', verified: true, verificationSource: 'tweet-detail-api' } });
    const c = m.buildResetCalendar(base({ tweets: [first, root, promise, other, otherPromise] }));
    assert.equal(assignment(c), undefined); assert.equal(row(c).confirmedCount, 0);
  }, 'if (matches.length !== 1) continue;', 'if (!matches.length) continue;'],
  ['不能在错过回复截止后退回主帖较宽的全天窗口', 'calendar', m => {
    const broad = tweet('902', '2026-10-23T04:47:00Z', 'The reset is coming tomorrow.', { inReplyTo: { ...root, relation: 'reply', verified: true, verificationSource: 'tweet-detail-api' } });
    const c = m.buildResetCalendar(base({ tweets: [first, root, broad, promise], records: [{ ...arrival, announced_at: '2026-10-23T20:00:00Z' }] }));
    assert.equal(assignment(c), undefined);
  }, '.sort((a, b) => timestamp(b.tweet.created_at) - timestamp(a.tweet.created_at))[0];',
  '.sort((a, b) => timestamp(a.tweet.created_at) - timestamp(b.tweet.created_at))[0];'],
  ['到账之后才发布的同日预告不能倒推事件归属', 'calendar', m => {
    const later = tweet(root.id, '2026-10-23T20:00:00Z', 'Day 18/ It’s reset day today.');
    const c = m.buildResetCalendar(base({ tweets: [first, later] }));
    assert.equal(assignment(c), undefined);
  }, 'promises.filter(({ tweet }) => timestamp(tweet.created_at) <= event.at)', 'promises'],
  ['未核验作者的日程不能为独立到账提供时间依据', 'calendar', m => {
    const unknown = tweet(root.id, '2026-10-23T16:30:00Z', 'Day 18/ It’s reset day today.', { author_verified: undefined });
    assert.equal(assignment(m.buildResetCalendar(base({ tweets: [first, unknown] }))), undefined);
  }, 'allTweets.filter((tweet) => tweet.author_verified === true &&', 'allTweets.filter((tweet) => tweet.author_verified !== false &&'],
  ['缺失作者核验的公开完成原帖不能借窗口自动归属', 'calendar', m => {
    const done = tweet('960', arrival.announced_at, 'Reset all propagated.', { author_verified: undefined });
    const c = m.buildResetCalendar(base({ tweets: [first, root, promise, done], records: [
      { id: done.id, type: 'reset', announced_at: done.created_at, url: done.url },
    ] }));
    assert.equal(assignment(c, done.id), undefined); assert.equal(row(c).confirmedCount, 0);
  }, 'trusted.filter((tweet) => tweet.author_verified === true && sameSource(event.sources, sourceIdentities(tweet, account)))',
  'trusted.filter((tweet) => sameSource(event.sources, sourceIdentities(tweet, account)))'],
  ['明确手工活动日优先于自动窗口归属', 'calendar', m => {
    const c = m.buildResetCalendar(base({ records: [{ ...arrival, programId, programDay: 19 }] }));
    assert.equal(row(c).confirmedCount, 0); assert.equal(row(c, 19).confirmedCount, 1);
  }, 'if (directlyAssigned.has(event) || event.record.programId) continue;', 'if (directlyAssigned.has(event)) continue;'],
  ['新 Day 21 宣告属于预告，不属于已到账', 'signals', m => {
    const post = tweet('2114588174249071102', '2026-10-26T05:21:22Z',
      'Day 21/ Wonder what happens the remaining seven days. But today is a reset.');
    assert.equal(m.analyzeTweet(post).level, 'explicit');
    assert.equal(m.confirmedResetEvent(post), null);
  }, 'that is|it[’\']s|it is|today is)', 'that is|it[’\']s|it is)'],
  ['只有提及但尚无到账记录的重置也统一显示预告', 'calendar', m => {
    const post = tweet('911', '2026-10-23T04:46:19Z', 'Day 18/ A reset.');
    const c = m.buildResetCalendar(base({ tweets: [first, post], records: [] }));
    assert.equal(row(c).status, 'pending'); assert.equal(row(c).entries[0].kind, 'announcement');
  }, "else if (analysis.level === 'occurred') kind = 'announcement';", "else if (analysis.level === 'occurred') kind = 'reset-unconfirmed';"],
  ['自动到账只兑现对应原帖，不吞同一天另一条独立预告', 'calendar', m => {
    const another = tweet('940', '2026-10-23T18:10:00Z', 'Day 18.1/ Another reset is coming soon.');
    const c = m.buildResetCalendar(base({ tweets: [first, root, promise, another] }));
    assert.equal(row(c).confirmedCount, 1);
    assert.ok(row(c).entries.some(entry => entry.id === another.id && entry.kind === 'announcement'));
  }, 'assignedManualProgramEvents.filter((event) => !event.record.programAssignmentSource)', 'assignedManualProgramEvents'],
  ['DOM verified 但没有官方 API 父关系时不能自动分配独立到账', 'calendar', m => {
    const dom = { ...promise, inReplyTo: { ...promise.inReplyTo, verificationSource: undefined } };
    const c = m.buildResetCalendar(base({ tweets: [first, root, dom] }));
    assert.equal(assignment(c), undefined);
  }, "if (requireApi && (ref.verified !== true || ref.verificationSource !== 'tweet-detail-api')) return null;", ''],
  ['同一承诺同秒人工与公开到账不双计', 'calendar', m => {
    const done = tweet('930', arrival.announced_at, 'Reset all propagated.');
    const c = m.buildResetCalendar(base({ tweets: [first, root, promise, done], records: [arrival,
      { id: done.id, type: 'reset', announced_at: done.created_at, url: done.url }] }));
    assert.equal(c.confirmedCount, 1); assert.equal(row(c).confirmedCount, 1);
  }, '(other.at < event.at || other.at === event.at && !event.record.manual)', '(other.at <= event.at)'],
];
for (const [name, moduleName, run, from, to] of cases) {
  check(name, () => run(modules[moduleName]));
  const broken = await mutate(moduleName, from, to);
  assert.throws(() => run(broken), undefined, `隔离变异必须被断言拦截：${name}`);
}

check('只有预告不产生到账，重复投影不新增记录且输入不变', () => {
  const input = base(); const original = JSON.stringify(input);
  const before = calendarModule.buildResetCalendar({ ...input, records: [] });
  assert.equal(row(before).confirmedCount, 0);
  const once = calendarModule.buildResetCalendar(input);
  const twice = calendarModule.buildResetCalendar(input);
  assert.deepEqual(once, twice); assert.equal(JSON.stringify(input), original);
});
check('不相干同日、未核验回复及无明确窗口不强配活动日', () => {
  for (const input of [
    base({ records: [{ ...arrival, announced_at: '2026-10-23T02:00:00Z' }] }),
    base({ tweets: [first, root, { ...promise, inReplyTo: { ...promise.inReplyTo, verified: false } }] }),
    base({ tweets: [first, root] }),
    base({ records: [{ ...arrival, manual: false, manualEntryId: undefined, id: 'unknown' }] }),
  ]) assert.equal(assignment(calendarModule.buildResetCalendar(input), input.records[0].id), undefined);
});
check('可信独立完成公告与 credit 到账均自动更新计划', () => {
  const done = tweet('920', arrival.announced_at, 'Reset all propagated.');
  const c = calendarModule.buildResetCalendar(base({ tweets: [first, root, promise, done],
    records: [{ id: done.id, type: 'reset', announced_at: done.created_at, url: done.url }] }));
  assert.equal(row(c).confirmedCount, 1); assert.equal(assignment(c, done.id).day, 18);
  const credit = calendarModule.buildResetCalendar(base({ records: [{ ...arrival, type: 'credit' }] }));
  assert.equal(row(credit).creditCount, 1);
});

const storedEntry = { id: manualId, status: 'landed', title: '额度重置已到账', note: '',
  occurredAt: new Date(arrival.announced_at).toISOString(), eventType: 'reset', createdAt: '2026-10-24T03:45:00Z', updatedAt: '2026-10-24T03:45:00Z' };
const programPost = tweet(programId, program.announcedAt, 'Either we reset once or pause for the next 28 days.');
const publicDone = tweet('930', '2026-10-23T17:50:00Z', 'Reset all propagated.');
const projectionInput = { resets: { records: [{ id: publicDone.id, type: 'reset', announced_at: publicDone.created_at, url: publicDone.url }] },
  tweets: { tweets: [programPost, first, root, promise, publicDone], updated_at: '2026-10-24T04:00:00Z' },
  manual: { revision: 1, entries: [storedEntry], history: [] }, now };
function assertProjection(module, input = projectionInput) {
  const projected = module.projectManualData(input);
  assert.equal(projected.resets.records.length, 1);
  const record = projected.resets.records[0];
  assert.equal(record.manualEntryId, manualId); assert.equal(record.programDay, 18);
  assert.equal(record.programId, programId); assert.ok(record.confirmation_urls.includes(publicDone.url));
  assert.equal(record.announced_at, storedEntry.occurredAt);
  assert.equal(projected.tweets.updated_at, input.tweets.updated_at);
  return projected;
}
check('手动到账及随后公开完成共享归属、去重与通知别名', () => {
  const original = JSON.stringify(projectionInput);
  assertProjection(manualModule);
  assert.equal(JSON.stringify(projectionInput), original);
  const withdrawn = manualModule.projectManualData({ ...projectionInput, manual: { revision: 2, entries: [], history: [] } });
  assert.equal(withdrawn.resets.records.length, 1); assert.equal(withdrawn.resets.records[0].id, publicDone.id);
});
check('同一承诺同秒到账在任意输入顺序下只计一次，保留人工时刻', () => {
  for (const quote of [null, { ...promise, relation: 'quote', verified: true, verificationSource: 'tweet-detail-api' }]) {
    const done = { ...publicDone, created_at: storedEntry.occurredAt, ...(quote ? { quotedTweet: quote } : {}) };
    const input = { ...projectionInput, resets: { records: [{ ...projectionInput.resets.records[0], announced_at: done.created_at }] },
      tweets: { ...projectionInput.tweets, tweets: [programPost, first, root, promise, done] } };
    for (const reversed of [false, true]) assertProjection(manualModule, {
      ...input, tweets: { ...input.tweets, tweets: reversed ? [...input.tweets.tweets].reverse() : input.tweets.tweets },
    });
  }
});
check('同秒但属于另一条明确活动日的到账保持独立，不按时刻合并', () => {
  const other = tweet('950', storedEntry.occurredAt, 'Day 19/ Reset all propagated.');
  const c = calendarModule.buildResetCalendar(base({ tweets: [first, root, promise, other], records: [arrival,
    { id: other.id, type: 'reset', announced_at: other.created_at, url: other.url }] }));
  assert.equal(c.confirmedCount, 2); assert.equal(row(c).confirmedCount, 1); assert.equal(row(c, 19).confirmedCount, 1);
});
for (const [from, to] of [
  ["if (manualRecords.length) {", 'if (false) {'],
  ['effectiveRecords.filter((record) => !covered.has(String(record.id)))', 'effectiveRecords'],
]) {
  const broken = await mutate('manual', from, to);
  assert.throws(() => assertProjection(broken), undefined, '归属和去重投影变异必须被拦截');
}

const serverSource = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8');
const notificationSource = serverSource.match(/async function getNotificationRecords\(\) \{[\s\S]*?\n\}/)[0];
const data = { resets: { records: [arrival] }, tweets: { tweets: [] } };
const plan = calendarModule.buildResetCalendar(base()).plan;
const notificationFn = text => runInNewContext(`${text};getNotificationRecords`, {
  store: { getData: async () => data }, getSignals: async () => ({ calendar: { plan } }),
  SOURCE_ACCOUNT: account, analyzeTweet: signalsModule.analyzeTweet, officialTweetId: () => null,
});
const notifications = await notificationFn(notificationSource)();
check('无推文补录的通知身份使用同一份自动计划归属', () => {
  assert.equal(notifications[0].programDay, 18); assert.equal(notifications[0].programId, programId);
  assert.equal(notifications[0].programAnchorId, root.id); assert.equal(notifications[0].programAssignmentSource, 'announcement-window');
});
const noAssignment = notificationSource.replace("if (Number.isInteger(assignment?.day)) return { ...record, programId: String(plan.programId), programDay: assignment.day,\n      programAssignmentSource: assignment.source, programAnchorId: assignment.anchorId };", '');
assert.notEqual(noAssignment, notificationSource);
assert.equal((await notificationFn(noAssignment)())[0].programDay, undefined);

const folder = await mkdtemp(resolve(tmpdir(), 'tibo-auto-program-'));
let server;
try {
  const rawRecords = [
    { id: 'history-1', type: 'reset', announced_at: '2026-10-10T04:00:00.000Z' },
    { id: 'history-2', type: 'reset', announced_at: '2026-10-20T04:00:00.000Z' },
  ];
  const rawTweets = { updated_at: '2026-10-26T06:00:00.000Z', tweets: [programPost, first, root, promise] };
  const persist = (name, value) => writeFile(resolve(folder, name), JSON.stringify(value, null, 2) + '\n');
  await persist('resets.json', { records: rawRecords }); await persist('tweets.json', rawTweets);
  await persist('stats.json', { generated_at: rawTweets.updated_at, errors: [] });
  const store = createStore(folder);
  const confirmations = [];
  server = createServer((req, res) => {
    handleManage(req, res, { store, account, now, onSaved: async detail => {
      const projected = await store.getData();
      confirmations.push({ newConfirmation: detail.newConfirmation,
        day: projected.resets.records.find(r => r.manualEntryId === detail.manualEntryId)?.programDay });
      return { sent: 0, failed: 0 };
    } }).catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/manage`;
  const request = async body => {
    const response = await fetch(endpoint, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    assert.equal(response.status, 200); return response.json();
  };
  const initial = await request();
  assert.equal(initial.programPlan.rows[17].status, 'pending');
  const saved = await request({ revision: initial.revision, action: 'save', entry: {
    status: 'landed', title: storedEntry.title, occurredAt: storedEntry.occurredAt, eventType: 'reset',
  } });
  assert.equal(saved.entry.programDay, undefined);
  const assigned = await request();
  assert.equal(assigned.programPlan.rows[17].status, 'mixed');
  assert.equal(assigned.records.find(r => r.manualEntryId === saved.entry.id).programDay, 18);
  assert.deepEqual(confirmations, [{ newConfirmation: true, day: 18 }]);
  const edited = await request({ revision: saved.revision, action: 'save', entry: {
    id: saved.entry.id, status: 'landed', title: storedEntry.title, note: '补充备注', occurredAt: storedEntry.occurredAt, eventType: 'reset',
  } });
  assert.deepEqual(confirmations.at(-1), { newConfirmation: false, day: 18 });
  await persist('tweets.json', { ...rawTweets, tweets: mergeTweetBatch(rawTweets.tweets, [
    { ...promise, inReplyTo: { ...promise.inReplyTo, verificationSource: undefined } }, publicDone,
  ]) });
  await persist('resets.json', { records: [...rawRecords, projectionInput.resets.records[0]] });
  const refreshed = await request();
  assert.equal(refreshed.records.length, rawRecords.length + 1);
  assert.equal(refreshed.programPlan.rows[17].status, 'mixed');
  assert.equal(refreshed.dataUpdatedAt, rawTweets.updated_at);
  await request({ revision: edited.revision, action: 'withdraw', entryId: saved.entry.id });
  const withdrawn = await request();
  assert.ok(withdrawn.records.some(r => r.id === publicDone.id));
  assert.equal(withdrawn.programPlan.rows[17].status, 'mixed');
  checks++;
  console.log('✓ 真实 HTTP 保存不填计划日自动同步，编辑不重确认，后续采集与撤销保持一致');
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(folder, { recursive: true, force: true });
}
for (const source of Object.values(sources)) assert.equal(sha(await readFile(source.url, 'utf8')), sha(source.text));
assert.equal(sha(await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')), sha(serverSource));
console.log(`✓ ${checks} 组自动归属行为与隔离反例通过，正式源码哈希未变`);
