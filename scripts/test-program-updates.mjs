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
assert.equal(digest(await readFile(copyUrl, 'utf8')), digest(source));
assert.equal(digest(await readFile(calendarUrl, 'utf8')), digest(calendarSource));
console.log(`\n${passed} 组通过；${mutants.length} 个隔离反例被拦截，原始输入与正式源码未改写`);
