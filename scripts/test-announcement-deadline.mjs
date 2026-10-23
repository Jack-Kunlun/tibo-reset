#!/usr/bin/env node
/** Day 17 主帖与自回复：承诺、截止点和实际落地必须分开。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as signals from '../src/lib/signals.mjs';
import * as outlook from '../src/lib/outlook.mjs';
import * as render from '../src/lib/render.mjs';
import * as view from '../miniprogram/utils/view.js';
import * as calendar from '../src/lib/reset-calendar.mjs';

const account = 'thsottiaux';
const root = { id: '2113162277688070445', account, author_verified: true, foundVia: 'with-replies',
  created_at: '2026-10-22T06:55:22.000Z',
  text: 'Day 17/ Bet you thought we forgot, but no, it’s reset day today. Also good time to remind you to get Daybreak Blue access, it only takes 15 mins and you don’t want to have to do it in the middle of an incident.' };
const reply = { id: '2113162413008884099', account, author_verified: true, foundVia: 'with-replies',
  created_at: '2026-10-22T06:55:54.000Z', text: 'Lands tomorrow before 10am PST.',
  inReplyTo: { ...root, verified: true, relation: 'reply' } };
const posts = [root, reply];
const now = Date.parse('2026-10-22T07:05:00Z');
const deadline = Date.parse('2026-10-22T18:00:00Z');
const history = [
  { id: 'prev', type: 'reset', announced_at: '2026-10-18T05:12:00Z' },
  { id: 'latest', type: 'reset', announced_at: '2026-10-20T06:33:48Z' },
];
const chart = { lastAt: history[1].announced_at };
const prediction = { prediction: { q10: 1, q50: 2, q90: 3 } };
const sig = signals.detectSignals(posts, { now });
const o = outlook.buildOutlook({ chart, prediction, signals: sig, now });
const calendarInput = { records: history,
  tweets: [{ ...root, id: 'day-one', created_at: '2026-10-05T08:00:00Z', text: 'Day 1/ Improvements' }, ...posts],
  signals: { ...sig, program: { days: 28, announcedAt: '2026-10-04T20:00:00Z' } }, now };
const modules = { signals, outlook, render, view, calendar };
const sources = {};
for (const [name, path] of Object.entries({ signals: '../src/lib/signals.mjs', outlook: '../src/lib/outlook.mjs', render: '../src/lib/render.mjs', view: '../miniprogram/utils/view.js', calendar: '../src/lib/reset-calendar.mjs' })) {
  const url = new URL(path, import.meta.url);
  sources[name] = { url, text: await readFile(url, 'utf8') };
}
const cases = [
  ['Day 17 正文中的 reset day 是明确预告', 'signals', m =>
    assert.equal(m.analyzeTweet(root).level, 'explicit'),
  '!hasResetDayAnnouncement(text) && !hasScheduledResetDeclaration(text);', 'true;'],
  ['愿望或猜测不能借 reset day 升格', 'signals', m =>
    assert.notEqual(m.analyzeTweet({ ...root, text: 'Day 17/ Maybe it’s reset day today.' }).level, 'explicit'),
  '!/\\b(?:maybe|hope|wish|yesterday|previously)\\b/i.test(s)', 'true'],
  ['已核验自回复可借父帖的重置主语', 'signals', m =>
    assert.equal(m.analyzeTweet(reply, { tweets: posts }).level, 'explicit'),
  "Boolean(linked && /^(?:lands?|landing)\\s+(?:tomorrow|today|before|by)\\b/i.test(text))", 'false'],
  ['未经核验的父帖不能生成到达承诺', 'signals', m =>
    assert.notEqual(m.analyzeTweet({ ...reply, inReplyTo: { ...reply.inReplyTo, verified: false } }, { tweets: posts }).level, 'explicit'),
  'node.inReplyTo?.verified === true', 'node.inReplyTo'],
  ['before 是截止点，不是 10 点开始的一小时', 'signals', m => {
    const w = m.analyzeTweet(reply, { tweets: posts }).window;
    assert.ok(w.deadline && w.fromTs === Date.parse('2026-10-22T08:00:00Z') && w.toTs === deadline);
  }, "const before = /\\b(?:before|by)\\s*$/.test(t.slice(0, cm.index));", 'const before = false;'],
  ['显式 PST 固定偏移优先于默认 UTC', 'signals', m =>
    assert.equal(m.analyzeTweet({ ...root, text: 'Global reset on October 22 before 10am PST.' }, { sourceZone: 'UTC' }).window.toTs, deadline),
  'zone: tz ? CLOCK_TZ_ALIAS[tz[1]] : zone', 'zone'],
  ['当地午夜后 tomorrow 不能按固定 PST 倒回一天', 'signals', m =>
    assert.equal(m.analyzeTweet({ ...root, created_at: '2026-10-22T07:30:00Z', text: 'Global reset tomorrow before 10am PST.' }).window.toTs, Date.parse('2026-10-23T18:00:00Z')),
  'const date = dated;', 'const date = dated && z !== zone ? parseTimes(dated.word, refTs, z).find(w => Number.isFinite(w.dayNum)) : dated;'],
  ['PST 不得被夏令时提前一小时', 'signals', m =>
    assert.equal(m.analyzeTweet(reply, { tweets: posts }).window.toTs, deadline),
  "pst: 'Etc/GMT+8'", "pst: 'America/Los_Angeles'"],
  ['来源时间保留原文 PST 的十点及 UTC-8', 'signals', m => {
    const w = m.analyzeTweet(reply, { tweets: posts }).window;
    assert.ok(w.sourceLabel === '原文 PST' && w.sourceZone.endsWith('10:00 前') && w.zones.b.offset === 'UTC-8');
  }, 'const displaySourceZone = w.clockZone ?? sourceZone;', 'const displaySourceZone = sourceZone;'],
  ['注明 PST 字面与当地夏令时的差异', 'signals', m =>
    assert.ok(m.analyzeTweet(reply, { tweets: posts }).timeNote.includes('若泛指洛杉矶当地夏令时')),
  "c.abbreviation === 'pst' &&", 'false &&'],
  ['时差说明的对象是原文 PST', 'signals', m =>
    assert.equal(m.analyzeTweet(reply, { tweets: posts }).window.zones.diffText, '北京时间比原文 PST快 16 小时'),
  'if (w.clockAbbreviation) zones.diffText =', 'if (false) zones.diffText ='],
  ['已过的具体截止点不能退回全天窗口', 'signals', m =>
    assert.equal(m.analyzeTweet({ ...root, created_at: '2026-10-22T19:00:00Z', text: 'Global reset today before 10am PST.' }).window, null),
  'if (dated && out.includes(dated)) out.splice(out.indexOf(dated), 1);', ''],
  ['活动日主帖作为自回复的依据保留', 'signals', m =>
    assert.deepEqual(m.detectSignals(posts, { now }).forecasts[0].evidence.map(e => e.id).sort(), posts.map(t => t.id).sort()),
  'lead.contextEvidence ?? []', '[]'],
  ['紧随主帖的时间补充只形成一次预告', 'signals', m => {
    const forecasts = m.detectSignals(posts, { now: Date.parse('2026-10-22T06:56:00Z') }).forecasts;
    assert.ok(forecasts.length === 1 && forecasts[0].window.toTs === deadline && forecasts[0].evidence.length === 2);
  }, 'if (refinedParents.has(s.id)) continue;', ''],
  ['自身另有重置承诺的回复不吞掉父帖的不同日预告', 'signals', m =>
    assert.equal(m.detectSignals([root, { ...reply, text: 'Global reset tomorrow before 10am PST.' }], { now: Date.parse('2026-10-22T06:56:00Z') }).forecasts.length, 2),
  'child.viaContext !== true || ', ''],
  ['预告不能变成实际到账事件', 'signals', m =>
    assert.equal(m.confirmedResetEvent(reply, { tweets: posts }), null),
  'export function confirmedResetEvent(tweet, opts = {}) {', 'export function confirmedResetEvent(tweet, opts = {}) { if (tweet.id === "2113162413008884099") return { type: "reset" };'],
  ['截止过后撤下预告而不虚构完成', 'signals', m =>
    assert.equal(m.detectSignals(posts, { now: deadline + 1 }).forecasts.length, 0),
  "if (to < now) return 'past';", ''],
  ['主卡锚定截止点并明确不是开始时刻', 'outlook', m => {
    const result = m.buildOutlook({ chart, prediction, signals: sig, now });
    assert.ok(result.etaAt === deadline && result.etaDeadline && result.etaNote.includes('截止'));
  }, 'f.window.deadline ? f.window.toTs : f.window.fromTs', 'f.window.fromTs'],
  ['网页主卡数到公告截止', 'render', m =>
    assert.ok(m.renderOutlook(o).includes('id="pcd-cap">距公告截止</span>')),
  "o.etaDeadline ? (over ? '公告截止已过' : '距公告截止')", "false ? ''"],
  ['网页详情不会把截止点写成前后或开启', 'render', m => {
    const html = m.renderSignal(sig);
    assert.ok(html.includes('粒度：最晚时间') && html.includes('2026.10.23（周五）02:00 前'));
  }, "f.window?.deadline ? '最晚时间'", "false ? '最晚时间'"],
  ['网页来源行跟随原文时区标签', 'render', m =>
    assert.ok(m.renderSignal(sig).includes('sw-k">原文 PST</span>')),
  "w.sourceLabel ?? 'Tibo 当地时间'", "'Tibo 当地时间'"],
  ['小程序主卡透传截止状态给倒计时', 'view', m => {
    const result = m.buildOutlookView(chart, prediction, sig, now);
    assert.equal(m.predCountdown(result, now).label, '距公告截止');
  }, 'etaDeadline: o.etaDeadline', 'etaDeadline: false'],
  ['小程序预告标题显示截止日期和之前', 'view', m =>
    assert.equal(m.buildSignal(sig).headline.sub, '10.23 · 02:00 前'),
  'w.deadline ? w.userDeadline : w.userFrom', 'w.userFrom'],
  ['截止倒数结束仍等待落地确认', 'view', m =>
    assert.equal(m.predCountdown({ etaAt: deadline, etaDeadline: true, etaKind: 'announced' }, deadline + 1).label, '公告截止已过 · 仍待落地确认'),
  "pred.etaDeadline ? '公告截止已过 · 仍待落地确认'", "false ? ''"],
  ['月日历当天呈现待落地而非普通更新', 'calendar', m =>
    assert.equal(m.buildResetCalendar(calendarInput).cells.find(c => c.date === '2026-10-22').status, 'pending'),
  "if (forecast?.level !== 'explicit') continue;", 'continue;'],
  ['活动 Day 17 标成重置预告', 'calendar', m =>
    assert.equal(m.buildResetCalendar(calendarInput).plan.rows.find(r => r.day === 17).status, 'pending'),
  "else if (analysis.level === 'explicit') kind = 'announcement';", ''],
];
let checks = 0;
for (const [name, key, run, from, to] of cases) {
  run(modules[key]);
  const { text, url } = sources[key];
  assert.ok(text.includes(from), '变异目标不存在：' + name);
  const mutant = text.replace(from, to).replace(/from (['"])(\.[^'"]+)\1/g, (_, q, path) => `from ${q}${new URL(path, url).href}${q}`);
  const broken = await import('data:text/javascript;base64,' + Buffer.from(mutant).toString('base64'));
  assert.throws(() => run(broken), undefined, '反例未被拦截：' + name);
  checks++;
  console.log('✓ ' + name);
}
const hash = text => createHash('sha256').update(text).digest('hex');
for (const source of Object.values(sources)) assert.equal(hash(await readFile(source.url, 'utf8')), hash(source.text));
console.log(`✓ ${checks} 项定向检查及隔离源码反例通过；源码哈希未变`);
