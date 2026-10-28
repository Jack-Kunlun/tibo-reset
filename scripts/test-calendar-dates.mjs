#!/usr/bin/env node
/** 同一来源在业务 Day 与北京时间日历之间必须可追溯，UTC 原始时间不改写。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildResetCalendar } from '../src/lib/reset-calendar.mjs';
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
const cases = [
  ['北京午夜两侧的功能更新落到不同日期，原始时间保持 UTC', build => {
    const c = build(input);
    assert.equal(cell(c, '2026-10-26').updatedCount, 1);
    assert.equal(cell(c, '2026-10-27').updatedCount, 3);
    assert.equal(cell(c, '2026-10-27').details.find(d => d.id === '3').createdAt, '2026-10-26T16:00:00.000Z');
    assert.equal(c.startWeekday, 6);
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
  }, " && tweet.manualDecision?.status !== 'ignored'", ''],
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
    assert.ok(renderResetCalendar({ ...c, zone: 'UTC' }).includes('· UTC 实际日期'));
  }, "zone: 'Asia/Shanghai'", "zone: 'UTC'"],
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
