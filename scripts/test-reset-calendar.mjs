#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const getSignalsSource = serverSource.match(/async function getSignals\(data\) \{[\s\S]*?\n\}/)?.[0];
const cacheRecords=[{id:'700',type:'reset',announced_at:'2026-10-06T00:00:00Z'},{id:'701',type:'reset',announced_at:'2026-10-07T00:00:00Z'}];
const getCachedSignals = runInNewContext(`let sigCache={key:null,value:null}; ${getSignalsSource}; getSignals`,{
  store:{getData:async()=>({tweets:{updated_at:'unchanged',tweets:[day1]},resets:{records:cacheRecords}})},
  latestEventMs,buildResetCalendar,detectSignals:()=>({program,forecasts:[]}),
  SOURCE_ACCOUNT:ACCOUNT,SOURCE_ZONE:'America/Los_Angeles',USER_ZONE:'Asia/Shanghai',Date,
});
const beforeCache=await getCachedSignals();cacheRecords[0].type='credit';const correctedCache=await getCachedSignals();cacheRecords.shift();const removedCache=await getCachedSignals();
check('同小时、同推文、同最新事件时，旧记录修正和删除立即刷新日历缓存',beforeCache.calendar.creditCount===0 && correctedCache.calendar.creditCount===1 && removedCache.calendar.confirmedCount===1);
const template = await readFile(resolve(ROOT,'src/index.html'),'utf8');
check('网页计划与预测位于主栏，实际日期日历位于侧栏依据之前',template.indexOf('<!--__OUTLOOK__-->')<template.indexOf('<!--__PROGRAM__-->') && template.indexOf('<!--__PROGRAM__-->')<template.indexOf('<!--__RESET_CALENDAR__-->') && template.indexOf('<!--__RESET_CALENDAR__-->')<template.indexOf('<!--__BASIS_SUMMARY__-->'));


/* -------------------- 活动原帖日序与隔离反例 -------------------- */
const planNow = '2026-10-21T02:00:00Z';
const realPlanInput = { records: recordsData.records, tweets: tweetsData.tweets, now: planNow };
const planFixture = (tweets, records = []) => ({ tweets: [day1, ...tweets], records,
  signals: { program }, now: '2026-10-10T12:00:00Z' });
const resetPost = tweet('810', '2026-10-06T04:00:00Z', 'Day 2/ Reset all propagated.');
const announcedPost = { ...resetPost, text: 'Day 2/ A reset is coming soon.' };
const aliasPost = tweet('811', '2026-10-08T01:00:00Z', 'Day 3/ Reset all propagated.');
const planPromise = tweet('870', '2026-10-06T04:01:00Z', 'Landing within the next 2 hours', {
  inReplyTo: { ...announcedPost, verified: true },
});
const planDone = tweet('871', '2026-10-06T05:00:00Z', 'Done and dusted', {
  quotedTweet: { account: ACCOUNT, text: planPromise.text, created_at: planPromise.created_at },
});
const doneRecord = { id: planDone.id, type: 'reset', announced_at: planDone.created_at };
const planCases = [
  {
    name: '审核跟进帖早于编号帖时停止关联',
    input: { ...realPlanInput, tweets: tweetsData.tweets.map(t => t.id === '2109132167112782291' ? { ...t, created_at: '2026-10-10T22:00:00Z' } : t) },
    verify: c => c.plan.rows[5].confirmedCount === 0,
    copyFrom: 'if (!Number.isFinite(age) || age <= 0 || age > 86_400_000) return null;', copyTo: 'if (false) return null;',
  },
  {
    name: '审核跟进帖超出一天后停止关联',
    input: { ...realPlanInput, tweets: tweetsData.tweets.map(t => t.id === '2109132167112782291' ? { ...t, created_at: '2026-10-12T04:01:09Z' } : t) },
    verify: c => c.plan.rows[5].confirmedCount === 0,
    copyFrom: 'if (!Number.isFinite(age) || age <= 0 || age > 86_400_000) return null;', copyTo: 'if (false) return null;',
  },
  {
    name: '没有归属的歧义事件不能撤下原帖的待核实标签',
    input: planFixture([resetPost, aliasPost],
      [{ id: '999', type: 'reset', announced_at: '2026-10-07T02:00:00Z', confirmation_urls: [resetPost.url, aliasPost.url] }]),
    verify: c => c.plan.rows[1].entries[0].kind === 'reset-unconfirmed' && c.plan.rows[2].entries[0].kind === 'reset-unconfirmed',
    from: 'const assignedEvents = posts.flatMap((post) => post.events);', to: 'const assignedEvents = events;',
  },
  {
    name: '只有跨活动日的确认别名而无直接来源时不猜归属，也不吞预告',
    input: planFixture([resetPost, aliasPost, tweet('881', '2026-10-07T00:00:00Z', 'Day 2/ Another reset is coming soon.')],
      [{ id: '999', type: 'reset', announced_at: '2026-10-07T02:00:00Z', confirmation_urls: [resetPost.url, aliasPost.url] }]),
    verify: c => c.confirmedCount === 1 && c.plan.rows.every(row => row.confirmedCount === 0) &&
      c.plan.rows[1].entries.some(e => e.id === '881' && e.kind === 'announcement'),
    from: 'new Set(candidates.map((post) => post.day)).size === 1 ? candidates[0] : null', to: 'candidates[0]',
  },
  {
    name: '确认记录的 ID 与 URL 指向不同活动日时不猜直接归属',
    input: planFixture([resetPost, aliasPost],
      [{ id: resetPost.id, url: aliasPost.url, type: 'reset', announced_at: resetPost.created_at }]),
    verify: c => c.plan.rows.every(row => row.confirmedCount === 0),
    from: 'new Set(candidates.map((post) => post.day)).size === 1 ? candidates[0] : null', to: 'candidates[0]',
  },
  {
    name: '当天一次重置确认不会吞掉另一条独立待落地承诺',
    input: planFixture([resetPost, tweet('880', '2026-10-06T06:00:00Z', 'Day 2.1/ Another reset is coming soon.')],
      [{ id: resetPost.id, type: 'reset', announced_at: resetPost.created_at }]),
    verify: c => c.plan.rows[1].confirmedCount === 1 && c.plan.rows[1].entries.some(e => e.id === '880' && e.kind === 'announcement'),
    from: 'if (settledPosts.has(String(tweet.id)) &&', to: 'if (true &&',
  },
  {
    name: '新的确认帖沿核验引用和自我回复链归到原编号，无需硬编码 ID',
    input: planFixture([announcedPost, planPromise, planDone], [doneRecord]),
    verify: c => c.plan.rows[1].confirmedCount === 1 && c.plan.rows[1].entries.some(e => e.id === planDone.id),
    from: 'if (!anchor) continue;', to: 'if (true) continue;',
  },
  {
    name: '未核验作者的完成帖不能沿会话关联活动日',
    input: planFixture([announcedPost, planPromise, { ...planDone, author_verified: undefined }], [doneRecord]),
    verify: c => c.plan.rows[1].confirmedCount === 0,
    from: 'if (node.author_verified !== true) return null;', to: '',
  },
  {
    name: '未核验的回复关系不能借给后续完成帖归日',
    input: planFixture([announcedPost, { ...planPromise, inReplyTo: { ...announcedPost, verified: false } }, planDone], [doneRecord]),
    verify: c => c.plan.rows[1].confirmedCount === 0,
    from: 'node.inReplyTo?.verified === true', to: 'node.inReplyTo',
  },
  {
    name: '引用原文和时刻匹配到多个父帖时不猜归属',
    input: planFixture([announcedPost, planPromise, { ...planPromise, id: '872' }, planDone], [doneRecord]),
    verify: c => c.plan.rows[1].confirmedCount === 0,
    from: 'if (matches.length !== 1) return null;', to: 'if (!matches.length) return null;',
  },
  {
    name: '计划原帖最新 Day 16 与 UTC 日历进度 17 独立，固定保留 28 天',
    input: realPlanInput,
    verify: c => c.plan.latestDay === 16 && c.progressDay === 17 && c.plan.rows.length === 28,
    from: 'const latestDay = Math.max(0, ...posts.map((post) => post.day));',
    to: 'const latestDay = Math.max(0, ...posts.map((post) => post.day)) + 1;',
  },
  {
    name: 'Day 2 子编号收全四项更新，汇总帖不重复计更新',
    input: realPlanInput,
    verify: c => c.plan.rows[1].updateCount === 4 && c.plan.rows[1].entries.filter(e => e.kind === 'roundup').length === 1,
    from: String.raw`(?:\.\d+|\s*\([^)]*\))?`, to: '',
  },
  {
    name: '跨 UTC 日的 Day 3 补充仍归 Day 3，更新与发券并存',
    input: realPlanInput,
    verify: c => c.plan.rows[2].updateCount === 2 && c.plan.rows[2].creditCount === 1 && c.plan.rows[2].status === 'mixed' &&
      !c.plan.rows[2].entries.some(e => ['announcement', 'reset-unconfirmed'].includes(e.kind)),
    from: "if (confirmedCount && updateCount) { status = 'mixed';", to: "if (confirmedCount && updateCount) { status = 'confirmed';",
  },
  {
    name: '历史完成跟进全部关联：Day 2、3、6、8、10、13、15 共七天确认',
    input: realPlanInput,
    verify: c => c.plan.resetDays === 7 && c.plan.rows[14].confirmedCount === 1 && c.plan.rows[14].entries.some(e => e.kind === 'reset'),
    from: 'const followup = match ? null : programFollowup(tweet, trusted);', to: 'const followup = null;',
  },
  {
    name: '后续完成的活动日不继续显示待落地，原始预告原文仍保留',
    input: realPlanInput,
    verify: c => c.plan.rows[5].status === 'confirmed' && !c.plan.rows[5].entries.some(e => e.kind === 'announcement') && c.plan.rows[5].entries.some(e => e.text.includes('Day 6/')),
    from: "if (settledPosts.has(String(tweet.id)) &&", to: 'if (false &&',
  },
  {
    name: '活动中缺失日标未见公告，最新日之后标待更新，不按日期补完成',
    input: planFixture([day3]),
    verify: c => c.plan.rows[1].status === 'missing' && c.plan.rows[3].status === 'future',
    from: 'else if (day <= latestDay)', to: 'else if (day < 0)',
  },
  {
    name: '非可信、其他账号、未核验、未来编号帖不能推进计划进度',
    input: planFixture([day3, ...[
      { foundVia: 'timeline' }, { account: 'someone' }, { author_verified: false }, { created_at: '2026-10-20T00:00:00Z' },
    ].map((extra, i) => tweet(String(820 + i), '2026-10-09T00:00:00Z', 'Day 6/ anything', extra))]),
    verify: c => c.plan.latestDay === 3 && c.plan.reportedDays === 2,
    from: 'const trusted = eligibleTweets(allTweets, normalizedAccount, currentTime);', to: 'const trusted = allTweets;',
  },
  {
    name: '同一编号帖重复采集只展示一次', input: planFixture([day3, day3]),
    verify: c => c.plan.rows[2].entries.length === 1,
    from: 'seen.has(String(tweet.id))', to: 'false',
  },
  {
    name: '同日无来源关联的历史重置不得拼入计划',
    input: planFixture([resetPost], [{ id: '999', type: 'reset', announced_at: resetPost.created_at }]),
    verify: c => c.plan.rows.every(row => row.confirmedCount === 0),
    from: 'new Set(candidates.map((post) => post.day)).size === 1 ? candidates[0] : null', to: 'candidates[0] ?? posts[0]',
  },
  {
    name: '仅原文声称已发生但未入确认记录时，标提及重置待核实',
    input: planFixture([resetPost]),
    verify: c => c.plan.rows[1].confirmedCount === 0 && c.plan.rows[1].entries[0].kind === 'reset-unconfirmed',
    from: "else if (analysis.level === 'occurred') kind = 'reset-unconfirmed';", to: "else if (analysis.level === 'occurred') kind = 'reset';",
  },
  {
    name: '预告即使误入历史也不能成为活动到账',
    input: planFixture([announcedPost], [{ id: announcedPost.id, type: 'reset', announced_at: announcedPost.created_at }]),
    verify: c => c.plan.rows[1].status === 'pending' && c.plan.rows[1].confirmedCount === 0,
    from: "!contradictsConfirmedHistory(post.tweet, { account, tweets: allTweets })", to: 'true',
    extra: ["return !matched.length || !matched.every((tweet) => contradictsConfirmedHistory(tweet, { account: normalizedAccount, tweets: allTweets }));", 'return true;'],
  },
  {
    name: '同一确认事件跨来源别名不重复计到不同活动日',
    input: planFixture([resetPost, aliasPost], [{ id: resetPost.id, type: 'reset', announced_at: resetPost.created_at, confirmation_urls: [aliasPost.url] }]),
    verify: c => c.plan.rows[1].confirmedCount === 1 && c.plan.rows[2].confirmedCount === 0,
    from: 'if (primary) primary.events.push(event);', to: 'for (const post of matches) post.events.push(event);',
  },
  {
    name: '闲聊提到明天 Day 17 不作为第 17 天的交付公告',
    input: planFixture([day3, tweet('850', '2026-10-09T00:00:00Z', 'See you tomorrow for Day 6!')]),
    verify: c => c.plan.latestDay === 3,
    from: String.raw`\s*\//i);`, to: '/i);',
  },
  {
    name: '中文摘要绑定原帖全文，编辑后不沿用既有发布结论',
    input: { ...realPlanInput, tweets: tweetsData.tweets.map(t => t.id === '2107158998495748264' ? { ...t, text: 'Day 1/ This change was cancelled.' } : t) },
    verify: c => c.plan.rows[0].entries[0].title.includes('cancelled') && !c.plan.rows[0].entries[0].isUpdate,
    copyFrom: "copy && createHash('sha256').update(text).digest('hex') === copy.hash", copyTo: 'copy',
  },
  {
    name: '确认记录删除时活动跟进不再宣称到账',
    input: { ...realPlanInput, records: recordsData.records.filter(r => r.id !== '2109132167112782291') },
    verify: c => c.plan.rows[5].confirmedCount === 0 && c.plan.rows[5].status !== 'confirmed',
    from: "const confirmedCount = resetCount + creditCount;", to: 'const confirmedCount = resetCount + creditCount + (day === 6 ? 1 : 0);',
  },
  {
    name: '审核跟进关联绑定双方全文，编号帖编辑后停止历史关联',
    input: { ...realPlanInput, tweets: tweetsData.tweets.map(t => t.id === '2109045220411351517' ? { ...t, text: 'Day 6/ Reset cancelled.' } : t) },
    verify: c => c.plan.rows[5].confirmedCount === 0,
    copyFrom: "if (!anchor || createHash('sha256').update(String(anchor.text ?? '')).digest('hex') !== link.anchorHash) return null;", copyTo: 'if (!anchor) return null;',
  },
];
const calendarPath = resolve(ROOT, 'src/lib/reset-calendar.mjs');
const copyPath = resolve(ROOT, 'src/lib/program-copy.mjs');
const [calendarText, copyText] = await Promise.all([readFile(calendarPath, 'utf8'), readFile(copyPath, 'utf8')]);
const hash = text => createHash('sha256').update(text).digest('hex');
const dataModule = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
for (const [index, item] of planCases.entries()) {
  check(item.name, item.verify(buildResetCalendar(item.input)));
  let mutant = calendarText;
  if (item.from) {
    assert.ok(mutant.includes(item.from), '反例目标存在：' + item.name);
    mutant = mutant.replace(item.from, item.to);
  }
  if (item.extra) mutant = mutant.replace(item.extra[0], item.extra[1]);
  const copyUrl = item.copyFrom ? dataModule(copyText.replace(item.copyFrom, item.copyTo)) : pathToFileURL(copyPath).href;
  mutant = mutant.replace("'./signals.mjs'", JSON.stringify(pathToFileURL(resolve(ROOT, 'src/lib/signals.mjs')).href))
    .replace("'./program-copy.mjs'", JSON.stringify(copyUrl));
  const module = await import(dataModule(mutant + '\n// isolated mutant ' + index));
  assert.equal(item.verify(module.buildResetCalendar(item.input)), false, '源码反例必须被该行为断言拦截：' + item.name);
}
assert.equal(hash(await readFile(calendarPath, 'utf8')), hash(calendarText));
assert.equal(hash(await readFile(copyPath, 'utf8')), hash(copyText));
console.log('\n' + passed + ' 项通过；' + planCases.length + ' 个活动计划源码反例被拦截，源码哈希未变');
