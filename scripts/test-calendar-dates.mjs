#!/usr/bin/env node
/** 同一来源在业务 Day 与北京时间日历之间必须可追溯，UTC 原始时间不改写。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildResetCalendar, withCalendarTranslations } from '../src/lib/reset-calendar.mjs';
import { sourceHash } from '../src/lib/tweet-translations.mjs';
import { derive } from '../src/lib/page.mjs';
import { renderResetCalendar } from '../src/lib/render.mjs';
import { buildCalendarView } from '../miniprogram/utils/view.js';

const calendarUrl = new URL('../src/lib/reset-calendar.mjs', import.meta.url);
const source = await readFile(calendarUrl, 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
const tweet = (id, created_at, text, extra = {}) => ({ id, created_at, text,
  account: 'thsottiaux', author_verified: true, foundVia: 'timeline-browser',
  url: `https://x.com/thsottiaux/status/${id}`, ...extra });
const posts = [
  tweet('1', '2026-10-25T01:00:00Z', 'Day 1/ We shipped API improvements.'),
  tweet('2', '2026-10-26T15:59:59.999Z', 'Day 2/ The new API is now available.'),
  tweet('3', '2026-10-26T16:00:00Z', 'Day 3/ You can now edit files in the desktop app.'),
  tweet('31', '2026-10-26T16:00:01Z', 'Day 3.1/ We have increased cache retention in the API.'),
  tweet('32', '2026-10-26T16:00:02Z', 'Day 3 (encore)/ We shipped faster CLI startup.'),
  tweet('4', '2026-10-26T16:01:00Z', 'Day 4/ A reset is coming soon.'),
  tweet('5', '2026-10-27T01:00:00Z', "Day 5/ We're still cooking."),
  tweet('6', '2026-10-27T02:00:00Z', 'Day 6/ Reset'),
  tweet('7', '2026-10-27T03:00:00Z', 'Day 7/ The new model is now available.', { manualDecision: { status: 'ignored' } }),
  tweet('8', '2026-10-27T04:00:00Z', 'Day 8/ The new API is now available.'),
];
const input = {
  tweets: [...posts, posts[2]],
  records: [
    { id: '91', type: 'reset', announced_at: '2026-10-26T16:02:00Z', first_confirmed_at: '2026-10-26T15:59:59.999Z' },
    { id: '92', type: 'credit', announced_at: '2026-10-26T16:00:00Z' },
  ],
  signals: { program: { id: 'program', days: 7, announcedAt: '2026-10-24T00:00:00Z' },
    forecasts: [{ level: 'explicit', timing: 'pending', evidence: [{ id: '4' }] }],
    accountObservations: [{ announcementId: '4', observedAt: '2026-10-27T16:00:00Z', sourceLabel: '账号反馈' }],
  },
  now: Date.parse('2026-10-28T01:00:00Z'),
};
const before = JSON.stringify(input);
const cell = (calendar, date) => calendar.cells.find(c => c.date === date);
const historyInput = {
  tweets: [posts[0], tweet('20', '2026-10-26T16:01:00Z', "Day 2/ It's reset day today.")],
  records: [{ id: '20', type: 'reset', announced_at: '2026-10-27T16:02:00Z', manual: true }],
  signals: { program: input.signals.program, forecasts: [] },
  now: Date.parse('2026-10-29T01:00:00Z'),
};
const oldestText = 'A reset has been completed.';
const oldestTweet = tweet('sep-reset', '2025-09-17T04:00:00Z', oldestText, {
  translation: { text: '一次重置已完成。', sourceHash: sourceHash(oldestText), language: 'zh-CN' },
});
const historicalInput = {
  tweets: [oldestTweet],
  records: [
    { id: oldestTweet.id, type: 'reset', manual: true, announced_at: oldestTweet.created_at, text: oldestText },
    { id: 'nov-credit', type: 'credit', manual: true, announced_at: '2026-11-14T10:00:00Z', text: 'November credit' },
  ],
  signals: { forecasts: [] },
  now: Date.parse('2026-11-15T04:00:00Z'),
};
const cases = [
  ['北京午夜两侧的功能更新落到不同日期，原始时间保持 UTC', build => {
    const c = build(input);
    assert.equal(cell(c, '2026-10-26').updatedCount, 1);
    assert.equal(cell(c, '2026-10-27').updatedCount, 3);
    assert.equal(cell(c, '2026-10-27').details.find(d => d.id === '3').createdAt, '2026-10-26T16:00:00.000Z');
    assert.equal(c.startWeekday, 3);
    assert.equal(cell(c, '2026-10-26').weekday, 0);
  }, 'ms + 8 * 3_600_000', 'ms'],
  ['北京午夜关闭上一日，今日标记与日历进度在同一边界切换', build => {
    const near = build({ ...input, now: Date.parse('2026-10-28T15:59:59.999Z'), signals: { ...input.signals, accountObservations: [] } });
    const after = build({ ...input, now: Date.parse('2026-10-28T16:00:00Z'), signals: { ...input.signals, accountObservations: [] } });
    assert.equal(cell(near, '2026-10-28').isToday, true);
    assert.equal(cell(near, '2026-10-28').status, 'future');
    assert.equal(cell(after, '2026-10-28').status, 'elapsed-no-record');
    assert.equal(cell(after, '2026-10-29').isToday, true);
    assert.equal(after.progressDay, near.progressDay + 1);
  }, '`${date}T00:00:00.000+08:00`', '`${date}T00:00:00.000Z`'],
  ['日历复用计划交付判断，纯重置、普通讨论、忽略和超活动日不算更新', build => {
    const c = build(input);
    assert.equal(c.updatedCount, c.plan.rows.reduce((sum, row) => sum + row.updateCount, 0));
    assert.equal(c.updatedCount, 5);
    assert.ok(!c.cells.flatMap(c => c.details).some(d => ['4', '5', '6', '7', '8'].includes(d.id) && d.roles.includes('updated')));
    assert.equal(c.plan.rows[2].updateCount, 3);
  }, 'if (!entry.isUpdate) continue;', 'if (false) continue;'],
  ['被人工排除的更新不通过 isUpdate 重新进入日历', build => {
    const c = build(input);
    assert.equal(c.plan.rows[6].updateCount, 0);
    assert.equal(cell(c, '2026-10-27').updatedCount, 3);
  }, "isUpdate: copy.kind === 'update' && tweet.manualDecision?.status !== 'ignored'", "isUpdate: copy.kind === 'update'"],
  ['更新、预告、实际确认及观察均按北京日期归格，角色与计数保持独立', build => {
    const c = build(input);
    assert.equal(cell(c, '2026-10-26').resetCount, 1);
    assert.equal(cell(c, '2026-10-27').creditCount, 1);
    assert.equal(cell(c, '2026-10-27').pendingCount, 1);
    assert.equal(cell(c, '2026-10-28').observedCount, 1);
    assert.equal(c.confirmedCount, 2);
    assert.equal(cell(c, '2026-10-27').status, 'confirmed');
  }, 'ms + 8 * 3_600_000', 'ms'],
  ['双端日期标题由服务端 zone 决定，旧 UTC 快照保持明确标识', build => {
    const c = build(input);
    assert.equal(c.zone, 'Asia/Shanghai');
    assert.equal(buildCalendarView(c).zoneLabel, '北京时间');
    assert.ok(renderResetCalendar(c).includes('· 北京时间'));
    assert.equal(buildCalendarView({ ...c, zone: 'UTC' }).zoneLabel, 'UTC 日期');
    assert.ok(renderResetCalendar({ ...c, months: undefined, zone: 'UTC' }).includes('· UTC 实际日期'));
  }, "zone: 'Asia/Shanghai'", "zone: 'UTC'"],
  ['跨日到账后保留发布日预告，不重复记到账或待落地', build => {
    const c = build(historyInput);
    const published = cell(c, '2026-10-27');
    assert.equal(published.status, 'announced');
    assert.equal(published.statusLabel, '重置预告 · 已落地');
    assert.equal(published.fulfilledForecastCount, 1);
    assert.equal(published.confirmedCount, 0);
    assert.equal(published.pendingCount + published.datedCount, 0);
    assert.equal(published.details.find(d => d.id === '20').forecastStatus, 'fulfilled');
    assert.equal(cell(c, '2026-10-28').confirmedCount, 1);
    assert.equal(c.confirmedCount, 1);
    assert.equal(c.pendingCount + c.datedCount, 0);
    assert.equal(buildCalendarView(c).gridCells.find(d => d.date === '2026-10-27').displayLabel, '预');
    assert.match(renderResetCalendar(c), /class="rc-cell rc-announced[^>]+title="2026-10-27[^>]*><b>10\/27<\/b><span>预<\/span>/);
  }, "if (entry.announcementStatus !== 'fulfilled') continue;", 'continue;'],
  ['已兑现预告不能污染待落地数量', build => {
    const c = build(historyInput);
    assert.equal(cell(c, '2026-10-27').pendingCount, 0);
    assert.equal(cell(c, '2026-10-27').status, 'announced');
  }, 'cell.fulfilledForecastCount++;', 'cell.pendingCount++; cell.fulfilledForecastCount++;'],
  ['计划在北京末日结束后标记已结束，不依赖最后一天原帖或到账数量', build => {
    const beforeEnd = build({ ...input, now: Date.parse('2026-10-31T15:59:59.999Z') });
    const afterEnd = build({ ...input, now: Date.parse('2026-10-31T16:00:00Z') });
    assert.equal(beforeEnd.toDate, '2026-10-31');
    assert.equal(beforeEnd.plan.ended, false);
    assert.equal(afterEnd.plan.ended, true);
    assert.equal(afterEnd.plan.endsAt, '2026-10-31T16:00:00.000Z');
    assert.equal(afterEnd.plan.latestDay, beforeEnd.plan.latestDay);
    assert.deepEqual(afterEnd.plan.rows, beforeEnd.plan.rows);
    for (const key of ['reportedDays', 'updatedDays', 'resetDays', 'latestDay']) assert.equal(afterEnd.plan[key], beforeEnd.plan[key]);
    assert.equal(beforeEnd.fromDate, '2026-10-01');
    assert.equal(afterEnd.fromDate, '2026-11-01');
    const allDaysEarly = build({ ...input, now: input.now, tweets: [...input.tweets,
      tweet('early-last-day', '2026-10-28T00:00:00Z', 'Day 7/ We shipped API improvements.')] });
    assert.equal(allDaysEarly.plan.latestDay, 7);
    assert.equal(allDaysEarly.plan.ended, false);
  }, '...buildProgramLifecycle({ toDate }, now)', 'ended: false'],
  ['月历跨月后继续按北京时间显示当月，结束计划保留原 7 天日期与明细', build => {
    const before = build(input);
    const nextMonth = build({ ...input, now: Date.parse('2026-12-01T00:00:00Z') });
    assert.equal(nextMonth.fromDate, '2026-12-01');
    assert.equal(nextMonth.toDate, '2026-12-31');
    assert.equal(nextMonth.days, 31);
    assert.equal(nextMonth.cells.length, 31);
    assert.equal(nextMonth.weeks.flat().length, 31);
    assert.equal(nextMonth.progressDay, 1);
    assert.equal(nextMonth.startWeekday, 1);
    assert.equal(nextMonth.plan.ended, true);
    assert.equal(nextMonth.plan.fromDate, '2026-10-25');
    assert.equal(nextMonth.plan.toDate, '2026-10-31');
    assert.deepEqual(nextMonth.plan.rows, before.plan.rows);
  }, 'const currentMonth = today.slice(0, 7);', "const currentMonth = today.slice(0, 4) + '-11';"],
  ['无活动计划时仍能展示当月到账，且有效计划仍保留独立视图', build => {
    const calendar = build({ records: [{ id: 'manual-nov14', type: 'reset', manual: true,
      announced_at: '2026-11-14T10:00:00Z', first_confirmed_at: '2026-11-14T10:00:00Z' }],
      tweets: [], signals: { program: null, forecasts: [] }, now: Date.parse('2026-11-15T04:00:00Z') });
    assert.equal(calendar.plan, null);
    assert.equal(calendar.fromDate, '2026-11-01');
    assert.equal(calendar.toDate, '2026-11-30');
    assert.equal(calendar.days, 30);
    assert.equal(calendar.cells.find(cell => cell.date === '2026-11-14').confirmedCount, 1);
    assert.ok(build(input).plan?.rows.length, '活动计划不能因月历滚动而丢失');
  }, 'const dayOne = validProgram ? trusted', 'const dayOne = false ? trusted'],
  ['历史月历从最早有效重置月份连续覆盖到当前月，事件只落在原日期', build => {
    const c = build(historicalInput);
    assert.equal(c.earliestMonth, '2025-09');
    assert.equal(c.currentMonth, '2026-11');
    assert.equal(c.months.length, 15);
    assert.equal(c.months[0].month, '2025-09');
    assert.equal(c.months.at(-1).month, '2026-11');
    assert.equal(c.months.find(m => m.month === '2025-09').confirmedCount, 1);
    assert.equal(c.months.find(m => m.month === '2025-09').resetCount, 1);
    assert.equal(c.months.find(m => m.month === '2026-11').confirmedCount, 1);
    assert.equal(c.months.find(m => m.month === '2026-11').creditCount, 1);
    assert.equal(c.months.find(m => m.month === '2026-11').cells.find(d => d.date === '2026-11-14').details[0].id, 'nov-credit');
    assert.ok(!c.months.find(m => m.month === '2026-11').cells.flatMap(d => d.details).some(d => d.id === 'sep-reset'));
    const allCells = c.months.flatMap(m => m.cells);
    assert.equal(allCells.length, c.months.reduce((n, m) => n + m.days, 0));
    assert.equal(new Set(allCells.map(d => d.date)).size, allCells.length);
    assert.equal(c.cells, c.months.at(-1).cells);
    assert.equal(c.plan, null);
    const translated = withCalendarTranslations(c, historicalInput.tweets);
    assert.equal(translated.months[0].cells.find(d => d.date === '2025-09-17').details[0].translation.text, '一次重置已完成。');
  }, 'const earliestMonth = historyMonths.length ? historyMonths.sort()[0] : currentMonth;', 'const earliestMonth = currentMonth;'],
  ['月份日期按各自然月生成，含跨年边界与闰年规则', build => {
    const c = build(historicalInput);
    const month = key => c.months.find(m => m.month === key);
    assert.deepEqual(['2025-09', '2025-12', '2026-01', '2026-02', '2026-11'].map(key => {
      const m = month(key);
      return [m.month, m.days, m.startWeekday, m.cells.length, m.cells[0].date, m.cells.at(-1).date];
    }), [
      ['2025-09', 30, 0, 30, '2025-09-01', '2025-09-30'],
      ['2025-12', 31, 0, 31, '2025-12-01', '2025-12-31'],
      ['2026-01', 31, 3, 31, '2026-01-01', '2026-01-31'],
      ['2026-02', 28, 6, 28, '2026-02-01', '2026-02-28'],
      ['2026-11', 30, 6, 30, '2026-11-01', '2026-11-30'],
    ]);
  }, 'getUTCDate();\n    const monthFromDate', 'getUTCDate() - 1;\n    const monthFromDate'],
  ['计划 Day 1 早于首笔到账时，最早月取两者中更早的计划月份', build => {
    const start = tweet('plan-day-one', '2025-09-30T04:00:00Z', 'Day 1/ Starting the reset program.');
    const c = build({ tweets: [start], records: [
      { id: 'first-reset', type: 'reset', manual: true, announced_at: '2025-10-02T04:00:00Z' },
    ], signals: { program: { id: 'historical-program', days: 7, announcedAt: '2025-09-29T04:00:00Z' } },
    now: Date.parse('2025-11-15T04:00:00Z') });
    assert.equal(c.earliestMonth, '2025-09');
    assert.equal(c.months[0].month, '2025-09');
    assert.equal(c.months.find(m => m.month === '2025-10').confirmedCount, 1);
    assert.equal(c.plan.fromDate, '2025-09-30');
    assert.equal(c.plan.rows.length, 7);
    assert.ok(c.months.every(month => !('plan' in month) && !('months' in month)));
  }, 'if (dayOne) historyMonths.push(', 'if (false) historyMonths.push('],
  ['无可用历史时只返回当前月，月界到达后自动新增月份', build => {
    const empty = build({ records: [], tweets: [], signals: {}, now: Date.parse('2026-11-30T15:59:59Z') });
    const afterMidnight = build({ records: [], tweets: [], signals: {}, now: Date.parse('2026-11-30T16:00:00Z') });
    assert.equal(empty.earliestMonth, '2026-11');
    assert.equal(empty.months.length, 1);
    assert.equal(empty.progressDay, 30);
    assert.equal(afterMidnight.currentMonth, '2026-12');
    assert.equal(afterMidnight.earliestMonth, '2026-12');
    assert.equal(afterMidnight.months.length, 1);
    assert.equal(afterMidnight.progressDay, 1);
  }, 'const earliestMonth = historyMonths.length ? historyMonths.sort()[0] : currentMonth;', "const earliestMonth = '2026-10';"],
];
for (const [index, [name, verify, from, to]] of cases.entries()) {
  verify(buildResetCalendar);
  assert.ok(source.includes(from), '反例须命中实际源码：' + name);
  const mutant = source.replace(from, to).replace(/from (['"])(\.[^'"]+)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, calendarUrl).href}${quote}`);
  const module = await import('data:text/javascript;base64,' + Buffer.from(mutant + `\n// date mutant ${index}`).toString('base64'));
  assert.throws(() => verify(module.buildResetCalendar), undefined, '反例必须被拦住：' + name);
  console.log('✓ ' + name);
}
assert.equal(JSON.stringify(input), before);
assert.equal(hash(await readFile(calendarUrl, 'utf8')), hash(source));
for (const record of [[], [{ ...historyInput.records[0], id: 'unrelated' }]]) {
  const c = buildResetCalendar({ ...historyInput, records: record });
  assert.equal(cell(c, '2026-10-27').fulfilledForecastCount, 0, '没有关联到账时不能宣布预告已兑现');
}
const ignored = buildResetCalendar({ ...historyInput, tweets: historyInput.tweets.map(t => t.id === '20' ? { ...t, manualDecision: { status: 'ignored' } } : t) });
assert.equal(cell(ignored, '2026-10-27').fulfilledForecastCount, 0, '排除的原帖不恢复历史预告');

const read = async name => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const [tweets, resets, statsFile] = await Promise.all([read('tweets'), read('resets'), read('stats')]);
const data = { tweets, resets, statsFile, account: 'thsottiaux', now: Date.parse('2026-10-28T01:06:00Z') };
const dataBefore = JSON.stringify(data);
const c = derive(data).signals.calendar;
const update = c.plan.rows[21].entries.find(e => e.id === '2114800277677092936');
assert.equal(update.isUpdate, true);
assert.equal(cell(c, '2026-10-27').status, 'updated');
assert.equal(cell(c, '2026-10-27').details.find(d => d.id === update.id).createdAt, update.createdAt);
assert.ok(!cell(c, '2026-10-26').details.some(d => d.id === update.id));
assert.equal(buildCalendarView(c).gridCells.find(d => d.date === '2026-10-27').displayLabel, '更新');
assert.match(renderResetCalendar(c), /class="rc-cell rc-updated[^>]+title="2026-10-27/);
assert.equal(JSON.stringify(data), dataBefore);
console.log('✓ 真实 Terra 更新的计划与日历共享同一来源，27 号显示更新且不改采集数据');
console.log(`\n${cases.length + 1} 组通过；${cases.length} 个隔离反例被拦住，输入和源码哈希保持不变`);
