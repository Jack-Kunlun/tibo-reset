#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { analyzeTweet, detectSignals, latestEventMs } from '../src/lib/signals.mjs';
import { buildResetCalendar } from '../src/lib/reset-calendar.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = 'thsottiaux';
const NOW = Date.parse('2026-10-20T07:02:15.882Z');
let passed = 0;
const check = (name, value) => { assert.ok(value, name); passed++; console.log(`✓ ${name}`); };

const [recordsData, tweetsData] = await Promise.all([
  readFile(resolve(ROOT, 'data/resets.json'), 'utf8').then(JSON.parse),
  readFile(resolve(ROOT, 'data/tweets.json'), 'utf8').then(JSON.parse),
]);
const signals = detectSignals(tweetsData.tweets, { now: NOW, account: ACCOUNT,
  lastResetAt: latestEventMs(recordsData.records.filter((r) => Date.parse(r.announced_at) <= NOW)) });

/* ----------------------- 当前真实快照 ----------------------- */

const current = buildResetCalendar({
  records: recordsData.records,
  tweets: tweetsData.tweets,
  signals,
  now: NOW,
});
check('真实 Day 1 锚定 UTC 10/05，而非 program.from 的 10/04', current?.fromDate === '2026-10-05');
check('当前 28 天格覆盖 10/05–11/01', current?.days === 28 && current.toDate === '2026-11-01');
check('真实快照计 7 条已确认事件（6 reset + 1 credit）',
  current?.confirmedCount === 7 && current.resetCount === 6 && current.creditCount === 1);
check('Day 15 随帖落地在 UTC 10/20，只增加一次确认而非待落地预告',
  current?.pendingCount === 0 && current.confirmedCount === 7 &&
  current.cells.find((cell) => cell.date === '2026-10-20')?.status === 'confirmed' &&
  current.cells.find((cell) => cell.date === '2026-10-20')?.confirmedCount === 1);
check('真实快照 Day 1 来源可追溯且进度按 UTC 日期计算',
  current?.sourceUrl === 'https://x.com/thsottiaux/status/2107158998495748264' && current.progressDay === 16);

/* ------------------------- 固定夹具 ------------------------- */

const tweet = (id, created_at, text, extra = {}) => ({
  id,
  account: ACCOUNT,
  created_at,
  text,
  url: `https://x.com/${ACCOUNT}/status/${id}`,
  foundVia: 'timeline-browser',
  author_verified: true,
  ...extra,
});
const program = {
  days: 7,
  announcedAt: '2026-10-04T20:33:43.000Z',
  from: '2026-10-04T07:00:00.000Z',
  url: 'https://x.com/thsottiaux/status/190',
};
const day1 = tweet('100', '2026-10-05T23:59:59.999Z', 'Day 1/ Starting the 28 day program', { author_verified: undefined });
const day2 = tweet('102', '2026-10-06T04:00:00.000Z', 'Day 2/ An improvement shipped');
const day3 = tweet('103', '2026-10-08T02:00:00.000Z', 'Day 3/ A clear improvement is now available');
const dated = tweet('305', '2026-10-07T22:00:00.000Z', "We'll reset everyone's usage limits in 2 hours.");
const pending = tweet('306', '2026-10-08T03:00:00.000Z', 'A reset is coming soon.');
const trustedComplete = tweet('201', '2026-10-07T00:00:30.000Z', 'Reset all propagated.');
const otherAccountDay1 = tweet('90', '2026-10-05T09:00:00.000Z', 'Day 1/ not the account', { account: 'someone' });
const untrustedDay1 = tweet('91', '2026-10-05T10:00:00.000Z', 'Day 1/ not a browser capture', { foundVia: 'timeline' });
const rejectedDay1 = tweet('92', '2026-10-05T11:00:00.000Z', 'Day 1/ explicitly unverified', { author_verified: false });
const wrongAccountForecast = tweet('401', '2026-10-07T03:00:00.000Z', 'A reset is coming soon.', { account: 'someone' });
const untrustedForecast = tweet('402', '2026-10-07T04:00:00.000Z', 'A reset is coming soon.', { foundVia: 'timeline' });
const rejectedForecast = tweet('403', '2026-10-07T05:00:00.000Z', 'A reset is coming soon.', { author_verified: false });
const futureForecast = tweet('404', '2026-10-20T18:00:00.000Z', 'A reset is coming soon.');

const datedAnalysis = analyzeTweet(dated, { account: ACCOUNT, tweets: [] });
const records = [
  { id: '200', type: 'reset', announced_at: '2026-10-07T00:00:00.000Z', url: 'https://x.com/thsottiaux/status/200', confirmation_urls: ['https://x.com/thsottiaux/status/200', trustedComplete.url] },
  { id: '201', type: 'reset', announced_at: '2026-10-07T00:00:01.000Z', url: trustedComplete.url },
  { id: '202', type: 'credit', announced_at: '2026-10-07T00:01:00.000Z', url: 'https://x.com/thsottiaux/status/202' },
  { id: '203', type: 'reset', announced_at: '2026-10-07T00:02:00.000Z', url: 'https://x.com/thsottiaux/status/203' },
  { id: '204', type: 'reset', announced_at: '2026-10-20T12:00:00.001Z', url: 'https://x.com/thsottiaux/status/204' },
  { id: '205', type: 'reset', announced_at: '2026-10-04T20:00:00.000Z', url: 'https://x.com/thsottiaux/status/205' },
];
const fixtureTweets = [day1, day2, day3, dated, pending, trustedComplete,
  otherAccountDay1, untrustedDay1, rejectedDay1, wrongAccountForecast, untrustedForecast,
  rejectedForecast, futureForecast];
const fixtureSignals = {
  program,
  forecasts: [
    { level: 'explicit', timing: 'pending', window: datedAnalysis.window, evidence: [{ id: dated.id, url: dated.url, text: dated.text }] },
    { level: 'explicit', timing: 'pending', window: null, evidence: [{ id: pending.id, url: pending.url, text: pending.text }] },
    { level: 'explicit', timing: 'pending', window: null, evidence: [{ id: pending.id, url: pending.url, text: pending.text }] },
    { level: 'hint', timing: 'pending', window: null, evidence: [{ id: pending.id, url: pending.url, text: pending.text }] },
    ...[wrongAccountForecast, untrustedForecast, rejectedForecast, futureForecast].map((item) => ({
      level: 'explicit', timing: 'pending', window: null, evidence: [{ id: item.id, url: item.url, text: item.text }],
    })),
  ],
};
const fixture = buildResetCalendar({ records, tweets: fixtureTweets, signals: fixtureSignals, now: '2026-10-10T12:00:00.000Z' });
const cell = (date) => fixture.cells.find((item) => item.date === date);

check('缺 author_verified 的可信浏览器 Day 1 可用，UTC 午夜边界不挪日',
  fixture?.fromDate === '2026-10-05' && fixture.cells[0].date === '2026-10-05' && fixture.startWeekday === 0);
check('Day N 按实际 UTC 发布日标更新，不按名义日序移格',
  cell('2026-10-08')?.details.some((item) => item.id === day3.id && item.dayNumber === 3 && item.createdAt.startsWith('2026-10-08')));
check('确认事件按 UTC 确认日入格，别名只计一次且同日多个事件保留',
  cell('2026-10-07')?.confirmedCount === 3 && cell('2026-10-07')?.resetCount === 2 && cell('2026-10-07')?.creditCount === 1);
check('未来确认记录不会提前入格', fixture.confirmedCount === 3);
check('带窗口预告与未定时预告独立计数，重复来源只计一次',
  fixture.datedCount === 1 && fixture.pendingCount === 1 &&
  cell('2026-10-07')?.datedCount === 1 && cell('2026-10-08')?.pendingCount === 1);
check('同日确认优先显示已确认，同时保留预告明细',
  cell('2026-10-07')?.status === 'confirmed' && cell('2026-10-07')?.details.some((item) => item.roles.includes('forecast')));
check('预告优先于更新，更新优先于空白日状态',
  cell('2026-10-08')?.status === 'pending' && cell('2026-10-06')?.status === 'updated' &&
  cell('2026-10-09')?.status === 'elapsed-no-record');
check('今天未结束时标为待观察并标 isToday，后续日期也待观察',
  cell('2026-10-10')?.status === 'future' && cell('2026-10-10')?.isToday === true && cell('2026-10-11')?.status === 'future');
check('输出可序列化，扁平格和 week 分组一致',
  JSON.stringify(fixture).length > 0 && fixture.cells.length === 7 && fixture.weeks.flat().length === 7);

check('显式 false、非浏览器来源或不同账号均不能锚定 Day 1',
  buildResetCalendar({ records: [], signals: { program }, now: '2026-10-10T12:00:00Z', tweets: [otherAccountDay1, untrustedDay1, rejectedDay1] }) === null);
check('缺失或超范围 program.days 不生成日历',
  buildResetCalendar({ records: [], tweets: [day1], signals: { program: { ...program, days: 0 } }, now: '2026-10-10T12:00:00Z' }) === null);

const fakeCompletion = buildResetCalendar({records:[{id:pending.id,type:'reset',announced_at:pending.created_at,url:pending.url}],tweets:[day1,pending],signals:{program,forecasts:[{level:'explicit',timing:'pending',evidence:[{id:pending.id}]}]},now:'2026-10-10T12:00:00Z'});
check('已采原文明示预告时，误标历史不能变成已到账',fakeCompletion.confirmedCount===0 && fakeCompletion.cells.find(c=>c.date==='2026-10-08').status==='pending');
check('进行中、取消和尚未可用的原帖均不能显示已到账', ['The reset is in progress.', 'The reset is cancelled.', 'A reset is planned but not available yet.'].every(text =>
  buildResetCalendar({records:[{id:pending.id,type:'reset',announced_at:pending.created_at,url:pending.url}],tweets:[day1,{...pending,text}],signals:{program},now:'2026-10-10T12:00:00Z'}).confirmedCount===0));
const firstConfirmation = buildResetCalendar({records:[{id:'500',type:'credit',announced_at:'2026-10-07T01:00:00Z',first_confirmed_at:'2026-10-06T23:00:00Z'}],tweets:[day1],signals:{program},now:'2026-10-10T12:00:00Z'});
check('首次确认跨UTC午夜时落在首次确认日，发券仍计一次',firstConfirmation.cells.find(c=>c.date==='2026-10-06').creditCount===1 && firstConfirmation.cells.find(c=>c.date==='2026-10-07').confirmedCount===0);
const bridgeRecords=[{id:'501',type:'reset',announced_at:'2026-10-07T01:00:00Z'},{id:'502',type:'reset',announced_at:'2026-10-07T02:00:00Z'},{id:'503',type:'reset',announced_at:'2026-10-07T03:00:00Z',confirmation_urls:['https://x.com/thsottiaux/status/501','https://x.com/thsottiaux/status/502']}];
check('晚到桥接别名与输入顺序不重复计到账', [bridgeRecords,[...bridgeRecords].reverse()].every(records=>buildResetCalendar({records,tweets:[day1],signals:{program},now:'2026-10-10T12:00:00Z'}).confirmedCount===1));
const finalDay = Date.parse('2026-11-01T08:00:00Z');
const finalSignals = detectSignals(tweetsData.tweets,{now:finalDay,lastResetAt:latestEventMs(recordsData.records),account:ACCOUNT});
const lastCalendar = buildResetCalendar({records:recordsData.records,tweets:tweetsData.tweets,signals:finalSignals,now:finalDay});
check('洛杉矶活动规则到期后，UTC末日日历仍保留',!finalSignals.program && lastCalendar?.toDate==='2026-11-01' && lastCalendar.progressDay===28);
const serverSource = await readFile(resolve(ROOT,'server/index.mjs'),'utf8');
const getSignalsSource = serverSource.match(/async function getSignals\(\) \{[\s\S]*?\n\}/)?.[0];
const cacheRecords=[{id:'700',type:'reset',announced_at:'2026-10-06T00:00:00Z'},{id:'701',type:'reset',announced_at:'2026-10-07T00:00:00Z'}];
const getCachedSignals = runInNewContext(`let sigCache={key:null,value:null}; ${getSignalsSource}; getSignals`,{
  store:{getTweets:async()=>({updated_at:'unchanged',tweets:[day1]}),getResets:async()=>({records:cacheRecords})},
  latestEventMs,buildResetCalendar,detectSignals:()=>({program,forecasts:[]}),
  SOURCE_ACCOUNT:ACCOUNT,SOURCE_ZONE:'America/Los_Angeles',USER_ZONE:'Asia/Shanghai',Date,
});
const beforeCache=await getCachedSignals();cacheRecords[0].type='credit';const correctedCache=await getCachedSignals();cacheRecords.shift();const removedCache=await getCachedSignals();
check('同小时、同推文、同最新事件时，旧记录修正和删除立即刷新日历缓存',beforeCache.calendar.creditCount===0 && correctedCache.calendar.creditCount===1 && removedCache.calendar.confirmedCount===1);
console.log(`\n${passed} 项通过`);
const template = await readFile(resolve(ROOT,'src/index.html'),'utf8');
check('网页日历位于侧栏依据之前，每日窗口移到主区之后',template.indexOf('<!--__RESET_CALENDAR__-->')<template.indexOf('<!--__BASIS_SUMMARY__-->') && template.indexOf('<!--__BASIS_SUMMARY__-->')<template.indexOf('<!--__PROGRAM__-->'));
