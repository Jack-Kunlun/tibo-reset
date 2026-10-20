#!/usr/bin/env node
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { analyzeTweet, detectSignals, latestEventMs } from '../src/lib/signals.mjs';
import { mergeConfirmedResets, mergeHistory, mergeTweetContexts } from '../src/lib/collect.mjs';
import { harvestExpression, detailProbeExpression, normalizeTimelineItems, pickFullTextCandidates, contextParentId } from '../src/lib/browser.mjs';
import { buildResetCalendar } from '../src/lib/reset-calendar.mjs';
import { buildChartData } from '../src/lib/chart-data.js';
import { buildOutlook } from '../src/lib/outlook.mjs';
import { announcementEventsFromForecasts, detectNewResets } from '../server/subscribe.mjs';

let passed = 0;
const check = (name, value) => { assert.ok(value, name); passed++; console.log(`✓ ${name}`); };
const account = 'thsottiaux';
const tweet = (id, created_at, text, extra = {}) => ({ id, created_at, text, account,
  url: `https://x.com/${account}/status/${id}`, author_verified: true, foundVia: 'timeline-browser', ...extra });
const day8 = tweet('2109812216212099456', '2026-10-13T01:03:25.000Z', 'Day 8/ Reset');
const eod = tweet('2109812360596865224', '2026-10-13T01:03:59.000Z', 'Global reset landing by EOD PST time. Enjoy');
const done8 = tweet('2109873287853707513', '2026-10-13T05:06:06.000Z', "What would you like with your side of reset? It's done. https://t.co/gpNaB6otgy");
const day10 = tweet('2110595484180214059', '2026-10-15T04:55:51.000Z', 'The reports of my reset button being lost are greatly exaggerated Day 10/ Reset');
const landing = tweet('2110595554036400151', '2026-10-15T04:56:07.000Z', 'Landing within the next 2 hours');
const done10 = tweet('2110618732666257557', '2026-10-15T06:28:13.000Z', 'Done and dusted');
const day15 = tweet('2112432076767289678', '2026-10-20T06:33:48.000Z',
  "Day 15/ Nevermind, we're still cooking... and reset. Enjoy.");
const base = [{ id: '2109132167112782291', announced_at: '2026-10-11T04:01:09.000Z', type: 'reset' }];

// 最小 DOM 替身保留真实页面的结构契约：引用时刻在前，本帖时间链接在后。
function article(t, quote = null) {
  const ownTime = { getAttribute: () => t.created_at, closest: () => ({ getAttribute: () => `/${t.account}/status/${t.id}` }) };
  // 引用卡里的 time 也带一个指向被引推文的链接 —— 真实 X 就是这个结构，
  // 而且它排在 `querySelectorAll('time')` 的**第一位**（与真页面一致）。
  const quoteTime = quote && { getAttribute: () => quote.created_at, closest: () => ({ getAttribute: () => `/${quote.account}/status/${quote.id}` }) };
  const card = quote && { innerText: `Tibo @${quote.account} ${quote.text}`, querySelector: () => quoteTime,
    contains: (node) => node === quoteTime };
  const quotedText = quote && { innerText: quote.text, closest: () => card };
  return {
    querySelector(s) {
      if (s === '[data-testid="tweetText"]') return { innerText: t.text };
      if (s === '[data-testid="User-Name"]') return { innerText: `Tibo @${t.account}` };
      if (s === 'div[role="link"] [data-testid="tweetText"]') return quotedText;
      return null;
    },
    querySelectorAll(s) { return s === 'time' ? [quoteTime, ownTime].filter(Boolean) : []; },
  };
}
const runDom = (expression, articles, id) => runInNewContext(expression, {
  location: { href: `https://x.com/${account}/status/${id}` },
  document: { querySelectorAll: () => articles },
});
const quotedRaw = runDom(harvestExpression(account), [article(done10, landing)], done10.id)[0];
check('引用卡不能夺走本帖的时间与 ID', quotedRaw.id === done10.id && quotedRaw.time === done10.created_at);
check('采集保留引用关系的作者、原文、时刻', quotedRaw.quotedTweet?.account === account && quotedRaw.quotedTweet?.text === landing.text && quotedRaw.quotedTweet?.created_at === landing.created_at);
const detail = runDom(detailProbeExpression(landing.id), [article(day10), article(landing)], landing.id);
check('详情页自我回复指向重置预告', detail.inReplyTo.id === day10.id && detail.inReplyTo.verified === true);
const l = { ...landing, inReplyTo: JSON.parse(JSON.stringify(detail.inReplyTo)) };
const d = { ...done10, ...normalizeTimelineItems([quotedRaw], { handle: account })[0] };
check('引用关系经过规范化后仍存在', d.quotedTweet?.text === landing.text);
check('短预告和完成短句也会去详情页补上下文', pickFullTextCandidates([{ tweets: [landing, done10] }]).picked.length === 2);
check('引用父帖可从已有库按作者、原文、时间精确定位', contextParentId(d.quotedTweet, [landing]) === landing.id);
check('父帖身份有歧义时不猜测关联', contextParentId(d.quotedTweet, [landing, { ...landing, id: '999' }]) === null);
const enriched = mergeTweetContexts([d], new Map([[landing.id, { inReplyTo: l.inReplyTo }]]), [landing]);
check('增量本轮没采到父帖也会保存详情页补出的上下文', enriched.some(t => t.id === landing.id && t.inReplyTo?.id === day10.id));

const pool = [day10, l, d];
const timed = analyzeTweet(l, { tweets: pool });
check('自我回复形成明确的两小时预告', timed.level === 'explicit' && timed.window?.from === landing.created_at && timed.window?.to === '2026-10-15T06:56:07.000Z');
check('完成短句沿引用和自我回复链判定为已发生', analyzeTweet(d, { tweets: pool }).level === 'occurred');

let history = base;
for (const [name, posts, before, after, expected] of [
  ['10 月 13 日', [day8, eod, done8], '2026-10-13T02:00:00Z', '2026-10-13T05:10:00Z', done8],
  ['10 月 15 日', pool, '2026-10-15T05:00:00Z', '2026-10-15T06:30:00Z', d],
]) {
  const pre = posts.filter(t => Date.parse(t.created_at) <= Date.parse(before));
  const beforeMerge = mergeConfirmedResets(history, pre, { now: Date.parse(before) });
  check(`${name}：预告不推进上次重置`, beforeMerge.added === 0);
  check(`${name}：重置之前显示预告`, detectSignals(pre, { now: Date.parse(before), lastResetAt: latestEventMs(history) }).forecasts.length > 0);
  const merged = mergeConfirmedResets(history, posts, { now: Date.parse(after) });
  check(`${name}：不等第三方收录即可入库`, merged.added === 1 && merged.records[0].id === expected.id);
  check(`${name}：最后重置时刻更新`, latestEventMs(merged.records) === Date.parse(expected.created_at));
  check(`${name}：重置后撤回预告`, detectSignals(posts, { now: Date.parse(after), lastResetAt: latestEventMs(merged.records) }).forecasts.length === 0);
  const repeat = mergeConfirmedResets(merged.records, posts, { now: Date.parse(after) });
  check(`${name}：重复采集不新增事件`, repeat.added === 0 && repeat.updated === 0 && JSON.stringify(repeat.records) === JSON.stringify(merged.records));
  history = merged.records;
}
for (const [name, posts] of [
  ['孤立完成短句', [done10]],
  ['只有发布时间接近而无关联', [day10, landing, done10]],
  ['别人引用', [day10, l, { ...d, quotedTweet: { ...d.quotedTweet, account: 'someone' } }]],
  ['父帖未经核验', [{ ...day10, author_verified: false }, l, d]],
  ['引用原文不匹配', [day10, l, { ...d, quotedTweet: { ...d.quotedTweet, text: 'Something else' } }]],
  ['完成超出承诺窗口', [day10, l, { ...d, created_at: '2026-10-15T08:00:00.000Z' }]],
  ['父帖比子帖更晚', [{ ...day10, created_at: '2026-10-15T05:00:00.000Z' }, l, d]],
  ['伪造的自我回复', [day10, { ...l, inReplyTo: { ...l.inReplyTo, verified: false } }, d]],
]) {
  const result = mergeConfirmedResets([done8].map(t=>({id:t.id,announced_at:t.created_at,type:'reset'})), posts, { now: Date.parse('2026-10-15T09:00:00Z') });
  check(`${name}不自动入库`, result.added === 0);
}
for (const text of ['Day 10/ Reset cancelled', 'Day 10/ Reset button now looks different', 'Day 10/ Reset of passwords', 'Day 10/ no reset today']) {
  check(`不把日程中的非重置承诺升级：${text}`, analyzeTweet({ ...day10, text }).level !== 'explicit');
}
for (const timed of [true, false]) {
  const root = { ...day10, text: 'Day 11/ Reset', created_at: '2026-10-15T06:20:00.000Z' };
  const follow = { ...l, created_at: '2026-10-15T06:21:00.000Z', inReplyTo: { ...l.inReplyTo, text: root.text, created_at: root.created_at } };
  const parent = timed ? follow : root;
  const completion = { ...d, created_at: '2026-10-15T06:40:00.000Z', quotedTweet: { account, text: parent.text, created_at: parent.created_at, relation: 'quote' } };
  const merged = mergeConfirmedResets([{ id: '300', type: 'reset', announced_at: '2026-10-15T06:00:00.000Z' }], timed ? [root, follow, completion] : [root, completion], { now: Date.parse('2026-10-15T07:00:00Z') });
  check(`两小时内的新${timed ? '定时' : '未定时'}承诺完成后另计一次重置`, merged.added === 1 && merged.updated === 0);
}
{
  const parent = { ...day10, text: 'A banked reset is landing within the next 2 hours' };
  const completion = { ...d, quotedTweet: { account, text: parent.text, created_at: parent.created_at, relation: 'quote' } };
  const merged = mergeConfirmedResets(base, [parent, completion], { now: Date.parse('2026-10-15T07:00:00Z') });
  check('完成短句继承已核验预告的发券类型', merged.records[0]?.type === 'credit');
}
{
  const oct17 = { id: '2111566005684289735', announced_at: '2026-10-17T21:12:21.000Z', type: 'reset' };
  const upstreamCompletion = { id: day15.id, announced_at: day15.created_at, type: 'reset', text: day15.text,
    url: day15.url, attribution: 'codex-resets.com' };
  const now = Date.parse('2026-10-20T07:10:00.000Z');
  const confirmed = mergeConfirmedResets([oct17], [day15], { now });
  check('10 月 20 日随帖落地公告直接判为 occurred', analyzeTweet(day15).level === 'occurred');
  check('Day 15 不等第三方收录即可新增，完成时刻取原帖而非采集时刻',
    confirmed.added === 1 && confirmed.records[0]?.id === day15.id &&
      confirmed.records[0].announced_at === day15.created_at && confirmed.records[0].attribution === `x.com/${account}`);
  const chart = buildChartData(confirmed.records, now);
  const signals = detectSignals([day15], { now, lastResetAt: latestEventMs(confirmed.records) });
  check('主卡最近重置为 20 日 14:33，北京和 UTC 指向同一时刻', chart.lastAt === day15.created_at);
  check('已经落地的 Day 15 不再提供预告或预告通知',
    signals.forecasts.length === 0 && announcementEventsFromForecasts(signals.forecasts, now).length === 0);
  const outlook = buildOutlook({ chart, signals,
    prediction: { prediction: { q10: 1, q25: 2, q50: 3, q75: 4, q90: 5 } }, now });
  check('主卡不再等待本次预告落地或推算本次到账 ETA', !outlook.announcement && outlook.etaBasis !== 'announcement-delay');
  const day1 = tweet('2107158998495748264', '2026-10-05T08:00:00.000Z', 'Day 1/ Improvements');
  const calendar = buildResetCalendar({ records: confirmed.records, tweets: [day1, day15], now,
    signals: { ...signals, program: { days: 28, announcedAt: '2026-10-04T20:33:43.000Z' } } });
  const today = calendar.cells.find(c => c.date === '2026-10-20');
  check('日历同一条 Day 15 已确认且无待落地重复项',
    today.status === 'confirmed' && today.confirmedCount === 1 && today.pendingCount === 0 &&
      today.details.some(d => d.id === day15.id && d.confirmedAt === day15.created_at));
  const newEvents = detectNewResets(confirmed.records, oct17.announced_at, now);
  check('本次只生成一条落地通知事件，保留原帖完成时间',
    newEvents.length === 1 && newEvents[0].id === day15.id && newEvents[0].announced_at === day15.created_at);
  check('确认后重复采集不新增、不更新',
    mergeConfirmedResets(confirmed.records, [day15], { now }).added === 0 &&
      mergeConfirmedResets(confirmed.records, [day15], { now }).updated === 0);
  const repeatedUpstream = mergeHistory(confirmed.records, [upstreamCompletion], { tweets: [day15] });
  check('第三方重采和 observed 别名不会重复入账',
    repeatedUpstream.records.length === confirmed.records.length &&
      mergeHistory(repeatedUpstream.records, [{ ...upstreamCompletion, id: `observed-${day15.id}` }], { tweets: [day15] }).records.length === confirmed.records.length);
  const followup = tweet('2112440000000000000', '2026-10-20T07:00:00.000Z', 'Reset all propagated.');
  const followed = mergeConfirmedResets(confirmed.records, [day15, followup], { now });
  check('稍后重复确认合并为同一事件，不后移首次落地时刻',
    followed.added === 0 && followed.updated === 1 && followed.records[0].announced_at === day15.created_at &&
      detectNewResets(followed.records, day15.created_at, now).length === 0);
  for (const extra of [{ author_verified: false }, { account: 'someone' }, { foundVia: 'timeline' }]) {
    check(`未核验原帖不因随帖落地句式自动入库：${JSON.stringify(extra)}`,
      mergeConfirmedResets([oct17], [{ ...day15, ...extra }], { now }).added === 0);
    check(`第三方转述不能绕过随帖落地来源核验：${JSON.stringify(extra)}`,
      mergeHistory([oct17], [upstreamCompletion], { tweets: [{ ...day15, ...extra }] }).added === 0);
  }
  for (const url of [day15.url, 'https://x.com/someone/status/2112432076767289678', null]) {
    check(`无可信原帖时第三方复述不能新增落地：${url}`,
      mergeHistory([oct17], [{ ...upstreamCompletion, url }], { tweets: [] }).added === 0);
  }
}

console.log(`✓ 重置全链路回放 ${passed} 项通过`);
