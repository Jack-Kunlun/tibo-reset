#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { programPostCopy } from '../src/lib/program-copy.mjs';
import { derive } from '../src/lib/page.mjs';
import { withCalendarTranslations } from '../src/lib/reset-calendar.mjs';
import { buildProgramPlanView } from '../miniprogram/utils/view.js';
import { renderProgramPlan } from '../src/lib/render.mjs';

const copyUrl = new URL('../src/lib/program-copy.mjs', import.meta.url);
const calendarUrl = new URL('../src/lib/reset-calendar.mjs', import.meta.url);
const source = await readFile(copyUrl, 'utf8');
const calendarSource = await readFile(calendarUrl, 'utf8');
const digest = (text) => createHash('sha256').update(text).digest('hex');
const load = (text) => import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('✓ ' + name); };

const day22 = 'Day 22/ Terra is back! Our first model that is significantly better at writing, personality and nuanced understanding of requests. Packs a punch across the board, very good at computer use, and gives 2X more usage than 6.1 Sol across API and subscriptions.';
const day24 = 'Day 24/ Text your dot just like anyone else. Makes it super easy to share/forward things, leave it voice notes or you can even go creative with "Hey Siri, text Iggy to <INSERT WILD REQUEST>" and sit back and relax.';
const day25 = 'Day 25/ We are doubling all usage limits for all Pro 100/200/500 tiers and Business Premium, effective today. We heard your kind feedback and won’t be reducing usage limits for Pro 200, so your Work and Codex usage will stay the same. We’re also going to continue offering extended limits for dots for now, and usage of your dot will still continue to be separate from your default usage. And we\'ll of course also keep shipping better models and other efficiency improvements that increase your effective usage over time.';
const examples = [
  ['真实 Day 22 不依赖人工摘要表', day22, 'update'],
  ['未知产品的明确发布', 'Day 23/ Nova model is now available through the API.', 'update'],
  ['新功能已交付', 'Day 23/ We shipped faster API routing.', 'update'],
  ['能力变化用现时语句说明', 'Day 23/ You can now edit previous messages in the desktop app.', 'update'],
  ['完成态与后续计划分句', 'Day 23/ We’ve released the new CLI. We will improve it further tomorrow.', 'update'],
  ['未来计划不算交付', 'Day 23/ We will ship a new API tomorrow.', 'note'],
  ['未来回归不算交付', 'Day 23/ Terra is back next week! Our model is better at writing.', 'note'],
  ['否定发布不算交付', 'Day 23/ We have not shipped the new API.', 'note'],
  ['回归疑问不算交付', 'Day 23/ Terra is back? Our model is better at writing.', 'note'],
  ['条件句不算交付', 'Day 23/ If the new model is now available, you can use it.', 'note'],
  ['撤回覆盖前面的发布', 'Day 23/ New model is now available. It was rolled back.', 'note'],
  ['只有情绪不算更新', "Day 23/ We're still cooking.", 'note'],
  ['纯重置不算更新', 'Day 23/ Reset', 'note'],
  ['重置预告不算更新', 'Day 23/ A reset is coming tomorrow.', 'note'],
  ['无编号普通帖子不补计划更新', 'We shipped a faster model in the API.', 'note'],
  ['子编号可自动更新', 'Day 23.2/ We have increased cache retention in the API.', 'update'],
  ['附注编号可自动更新', 'Day 23 (encore)/ We shipped a faster model in Codex.', 'update'],
  ['汇总帖不重复计一次更新', 'Day 23/ Recap: We shipped a faster model in Codex.', 'roundup'],
  ['猜测当前可用不算发布', 'Day 23/ Maybe the new model is now available.', 'note'],
  ['交付尚未向用户开放不算已上线', 'Day 23/ We shipped API changes, but they are not available to users.', 'note'],
  ['真实 Day 24 当前能力介绍', day24, 'update'],
  ['真实 Day 25 今日生效的额度提升', day25, 'update'],
  ['新编号的助手能力介绍', 'Day 26/ Message your assistant to send it a voice note.', 'update'],
  ['当前可以给 Dot 发消息', 'Day 26/ You can now text your dot from your phone.', 'update'],
  ['弯引号和立即生效的额度调整', 'Day 26/ We’re increasing all usage limits, effective immediately.', 'update'],
  ['未来能力介绍不算交付', 'Day 26/ Text your dot tomorrow from your phone.', 'note'],
  ['转述用户愿望不算交付', 'Day 26/ A user asked: text your dot from your phone.', 'note'],
  ['否定现有能力不算交付', 'Day 26/ You can now text your dot, but it is not available to users yet.', 'note'],
  ['当前能力疑问不算交付', 'Day 26/ Text your dot from your phone?', 'note'],
  ['额度调整未说明生效不算交付', 'Day 26/ We are doubling all usage limits.', 'note'],
  ['额度调整未来生效不算交付', 'Day 26/ We are doubling all usage limits, effective next week.', 'note'],
  ['额度调整条件未成不算交付', 'Day 26/ We are doubling all usage limits, effective today if capacity allows.', 'note'],
  ['额度调整有否定限制不算交付', 'Day 26/ We are doubling all usage limits, effective today, but not for users yet.', 'note'],
  ['额度调整疑问不算交付', 'Day 26/ We are doubling all usage limits, effective today?', 'note'],
  ['玩笑撤回当前能力', 'Day 26/ Text your dot from your phone. Just kidding, today is a reset.', 'note'],
  ['玩笑撤回即时调整', 'Day 26/ We are doubling all usage limits, effective today. Just joking, today is a reset.', 'note'],
  ['真实 Day 23 玩笑和重置不能冒充更新', 'Day 23/ Much requested iCloud Main & Calendar plugins. Just kidding, today is a reset. Still much requested though!', 'note'],
  ['无编号的能力介绍不补进计划', 'Text your dot just like anyone else.', 'note'],
];
for (const [name, text, expected] of examples) check(name, () => {
  assert.equal(programPostCopy({ id: 'new-unknown-id', text }).kind, expected);
});
check('只用本人原文，不借引用或翻译宣称交付', () => {
  assert.equal(programPostCopy({ text: 'Day 23/ Interesting.',
    quotedTweet: { text: 'The API model is now available.' },
    translation: { text: '新模型已上线', language: 'zh-CN' } }).kind, 'note');
});

const mutants = [
  ["kind: inferredProgramKind(text, body)", "kind: 'note'", { text: day22 }, 'update'],
  ["!PROGRAM_DAY.test(text) || UPDATE_WITHDRAWN.test(body)", 'UPDATE_WITHDRAWN.test(body)', { text: 'We shipped the new API.' }, 'note'],
  ["!PROGRAM_DAY.test(text) || UPDATE_WITHDRAWN.test(body)", '!PROGRAM_DAY.test(text)', { text: examples[10][1] }, 'note'],
  ["!UPDATE_UNCERTAIN.test(clause)", 'true', { text: examples[18][1] }, 'note'],
  ["!UPDATE_NEGATED.test(clause)", 'true', { text: examples[19][1] }, 'note'],
  ['UPDATE_CURRENT_CAPABILITY.test(clause)', 'false', { text: day24 }, 'update'],
  ['UPDATE_EFFECTIVE_CHANGE.test(clause) && UPDATE_EFFECTIVE_TIME.test(clause)', 'false', { text: day25 }, 'update'],
  ['UPDATE_EFFECTIVE_TIME.test(clause)', 'true', { text: 'Day 26/ We are doubling all usage limits.' }, 'note'],
  ['|just kidding|just joking|only joking', '', { text: 'Day 26/ Text your dot from your phone. Just kidding, today is a reset.' }, 'note'],
];
for (const [index, [from, to, tweet, expected]] of mutants.entries()) {
  assert.ok(source.includes(from), '反例必须命中正式源码');
  const mutant = await load(source.replace(from, to) + `\n// mutant ${index}`);
  assert.throws(() => assert.equal(mutant.programPostCopy(tweet).kind, expected), undefined, `未拦住反例 ${index}`);
}

const read = async (name) => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const [tweets, resets, statsFile] = await Promise.all([read('tweets'), read('resets'), read('stats')]);
const now = Date.parse('2026-10-27T07:02:00Z');
const input = { tweets, resets, statsFile, now, account: 'thsottiaux' };
const inputBefore = JSON.stringify(input);
const result = derive(input);
const plan = result.signals.calendar.plan;
const row = plan.rows[21];

check('真实数据经正常派生链路自动变为 Day 22 更新，不提前记重置', () => {
  assert.equal(plan.latestDay, 22);
  assert.equal(row.status, 'updated');
  assert.equal(row.updateCount, 1);
  assert.equal(row.confirmedCount, 0);
  assert.equal(row.entries[0].id, '2114800277677092936');
  assert.equal(row.entries[0].isUpdate, true);
  assert.equal(row.entries[0].confirmedAt, null);
  assert.ok(row.entries[0].translation?.text);
});
check('小程序既有视图直接显示更，网页同步显示发布更新', () => {
  const vm = buildProgramPlanView(plan);
  assert.equal(vm.days[21].marker, '更');
  assert.equal(vm.days[21].statusClass, 'updated');
  assert.equal(vm.days[21].entries[0].labels[0].text, '功能更新');
  const html = renderProgramPlan(plan, result.signals.program);
  assert.match(html, /class="plan-cell plan-updated[^"]*"[^>]*data-plan-select="22"/);
  assert.match(html, /id="program-day-22"[\s\S]*?<summary><b>Day 22<\/b><span>发布更新<\/span>/);
});

const oldCopySource = source.replace('kind: inferredProgramKind(text, body)', "kind: 'note'");
const oldCopyUri = 'data:text/javascript;base64,' + Buffer.from(oldCopySource).toString('base64');
const oldCalendarSource = calendarSource.replace("from './program-copy.mjs'", `from '${oldCopyUri}'`)
  .replace(/from (['"])(\.[^'"]+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, calendarUrl).href}${quote}`);
const oldCalendar = withCalendarTranslations((await load(oldCalendarSource)).buildResetCalendar({
  tweets: tweets.tweets, records: resets.records, signals: result.signals, now,
}), tweets.tweets);
check('相同输入与旧规则对拍：只补 Day 22 的更新，不改既有计划和到账统计', () => {
  assert.equal(oldCalendar.plan.rows[21].updateCount, 0);
  assert.equal(result.signals.calendar.plan.updatedDays, oldCalendar.plan.updatedDays + 1);
  assert.deepEqual(plan.rows.filter((row) => row.day !== 22), oldCalendar.plan.rows.filter((row) => row.day !== 22));
  for (const key of ['confirmedCount', 'resetCount', 'creditCount', 'pendingCount', 'observedCount']) {
    assert.equal(result.signals.calendar[key], oldCalendar[key], key);
  }
  assert.deepEqual(plan.eventAssignments, oldCalendar.plan.eventAssignments);
  assert.equal(JSON.stringify(input), inputBefore);
});

const currentInput = { tweets, resets, statsFile, now: Date.parse('2026-10-30T06:02:00Z'), account: 'thsottiaux' };
const currentBefore = JSON.stringify(currentInput);
const current = derive(currentInput);
check('两条真实新帖经正常链路同时更新计划、日历、网页和小程序', () => {
  for (const [day, date, id, text] of [[24, '2026-10-29', '2115622002581188681', day24], [25, '2026-10-30', '2115850175868727621', day25]]) {
    assert.equal(tweets.tweets.find(t => t.id === id)?.text, text);
    const row = current.signals.calendar.plan.rows[day - 1];
    assert.equal(row.status, 'updated');
    assert.equal(row.updateCount, 1);
    assert.equal(row.confirmedCount, 0);
    assert.equal(row.entries[0].id, id);
    const cell = current.signals.calendar.cells.find(cell => cell.date === date);
    assert.equal(cell.status, 'updated');
    assert.equal(cell.updatedCount, 1);
    assert.equal(cell.confirmedCount, 0);
    assert.ok(cell.details.some(detail => detail.id === id && detail.roles.includes('updated')));
    assert.equal(buildProgramPlanView(current.signals.calendar.plan).days[day - 1].marker, '更');
    assert.match(renderProgramPlan(current.signals.calendar.plan, current.signals.program), new RegExp(`class="plan-cell plan-updated[^"]*"[^>]*data-plan-select="${day}"`));
  }
  assert.equal(JSON.stringify(currentInput), currentBefore);
});
const previousCopy = source.replace('UPDATE_CURRENT_CAPABILITY.test(clause)', 'false')
  .replace('UPDATE_EFFECTIVE_CHANGE.test(clause) && UPDATE_EFFECTIVE_TIME.test(clause)', 'false');
const previousUri = 'data:text/javascript;base64,' + Buffer.from(previousCopy).toString('base64');
const previousCalendarSource = calendarSource.replace("from './program-copy.mjs'", `from '${previousUri}'`)
  .replace(/from (['"])(\.[^'"]+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, calendarUrl).href}${quote}`);
const previousCalendar = withCalendarTranslations((await load(previousCalendarSource)).buildResetCalendar({
  tweets: tweets.tweets, records: resets.records, signals: current.signals, now: currentInput.now,
}), tweets.tweets);
check('近期对拍只增加两天功能更新，不改重置、预告、归属或原始数据', () => {
  const calendar = current.signals.calendar;
  assert.equal(calendar.plan.updatedDays, previousCalendar.plan.updatedDays + 2);
  assert.deepEqual(calendar.plan.rows.filter(row => ![24, 25].includes(row.day)), previousCalendar.plan.rows.filter(row => ![24, 25].includes(row.day)));
  for (const key of ['confirmedCount', 'resetCount', 'creditCount', 'pendingCount', 'datedCount', 'observedCount']) assert.equal(calendar[key], previousCalendar[key], key);
  assert.deepEqual(calendar.plan.eventAssignments, previousCalendar.plan.eventAssignments);
  assert.equal(JSON.stringify(currentInput), currentBefore);
});
assert.equal(digest(await readFile(copyUrl, 'utf8')), digest(source));
assert.equal(digest(await readFile(calendarUrl, 'utf8')), digest(calendarSource));
console.log(`\n${passed} 组通过；${mutants.length} 个隔离反例被拦截，原始输入与正式源码未改写`);
