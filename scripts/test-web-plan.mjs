#!/usr/bin/env node
/** 网页计划与近期节奏呈现；切换不能重判、丢来源或直出机器时间。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { renderProgramPlan, renderAll, renderRecentRhythm } from '../src/lib/render.mjs';
import { rhythmScene, sceneBounds } from '../src/lib/scene.js';
import { derive } from '../src/lib/page.mjs';
import { buildProgramPlanView } from '../miniprogram/utils/view.js';

const template = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const rendererSource = await readFile(new URL('../src/lib/render.mjs', import.meta.url), 'utf8');
const rendererUrl = new URL('../src/lib/render.mjs', import.meta.url);
const sceneUrl = new URL('../src/lib/scene.js', import.meta.url);
const sceneSource = await readFile(sceneUrl, 'utf8');
const program = { days: 28, window: {}, url: 'https://x.com/thsottiaux/status/program' };
const statuses = ['updated', 'mixed', 'pending', 'missing', 'future'];
const rows = Array.from({ length: 28 }, (_, i) => ({ day: i + 1,
  status: statuses[Math.min(i, 4)], statusLabel: ['发布更新', '更新与重置', '重置预告', '未见公告', '待更新'][Math.min(i, 4)],
  entries: i === 1 ? [{ id: 'update', title: '改进 <标题>', text: 'Day 2/ <原文> & details', kind: 'update', isUpdate: true,
    createdAt: '2026-10-06T16:10:00Z', url: 'https://x.com/thsottiaux/status/2' },
  { id: 'reset', title: '重置已确认', text: 'Done', kind: 'reset', createdAt: '2026-10-07T01:20:00Z', confirmedAt: '2026-10-07T01:20:00Z' }] : [] }));
const plan = { title: 'Tibo 28 天计划', days: 28, latestDay: 2, reportedDays: 2, updatedDays: 1, resetDays: 1, rows };
const digest = value => createHash('sha256').update(value).digest('hex');
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('✓ ' + name); };
const cases = [
  ['完整保留28日投影，不把日历日期当活动编号', render => {
    const html = render(plan, program);
    assert.deepEqual([...html.matchAll(/data-plan-select="(\d+)"/g)].map(m => Number(m[1])), rows.map(row => row.day));
  }, 'const cells = plan.rows.map((row) => {', 'const cells = plan.rows.slice(0, 27).map((row) => {'],
  ['默认选择最新原帖日', render => {
    const html = render(plan, program);
    assert.equal(html.match(/class="plan-day is-selected" id="program-day-(\d+)"/)[1], '2');
  }, 'row.day === plan.latestDay', 'row.day === 1'],
  ['逐日更新与确认来源都渲染到HTML，脚本关闭时仍可查看', render => {
    assert.ok(render(plan, program).includes('重置已确认'));
  }, 'row.entries.map((entry)', 'row.entries.slice(0, 1).map((entry)'],
  ['来源时刻按北京格式化，不直出ISO', render => {
    assert.ok(render(plan, program).includes('2026.10.07 00:10 北京'));
  }, 'esc(fmtDateTime(entry.createdAt))', 'esc(entry.createdAt)'],
  ['标题与原文转义，不能变成HTML节点', render => {
    const html = render(plan, program);
    assert.ok(html.includes('改进 &lt;标题&gt;') && html.includes('Day 2/ &lt;原文&gt; &amp; details'));
  }, 'esc(entry.title || entry.text || \'原帖摘要暂不可用\')', '(entry.title || entry.text || \'原帖摘要暂不可用\')'],
  ['有规则而缺计划时保留原始规则', render => {
    assert.ok(render(null, program).includes('class="sig-prog"'));
  }, 'return renderProgram(program);', "return '';"],
  ['无规则也无计划时不留空卡', render => {
    assert.equal(render(null, null), '');
  }, 'if (!plan?.rows?.length) return renderProgram(program);', 'if (!plan?.rows?.length) return \'<section></section>\';'],
  ['未来与缺失只说明采集状态，不捏造已交付', render => {
    const html = render(plan, program);
    assert.ok(html.includes('原帖尚未更新到这一天。') && html.includes('尚未采集到这一天的原帖。'));
  }, "row.status === 'future'", 'false'],
];
for (const [name, run] of cases) check(name, () => run(renderProgramPlan));

check('双端只显示更新、预告、到账及组合，空状态统一为短横线', () => {
  const examples = [
    { status: 'updated', marker: '更' },
    { status: 'pending', marker: '预' },
    { status: 'confirmed', marker: '重' },
    { status: 'mixed', marker: '双' },
    { status: 'noted', marker: '-', entries: [{ kind: 'note', text: 'Ordinary discussion' }] },
    { status: 'missing', marker: '-' },
    { status: 'future', marker: '-' },
    { status: 'unknown', marker: '-' },
    { status: 'noted', marker: '预', entries: [{ kind: 'reset-unconfirmed', text: 'A reset is coming' }] },
    { status: 'observed', marker: '重', updateCount: 0 },
    { status: 'observed', marker: '双', updateCount: 1 },
  ];
  const fixture = { ...plan, latestDay: 6, rows: examples.map((example, i) => ({
    ...example, day: i + 1, statusLabel: '旧版状态文案', entries: example.entries || [],
  })) };
  const before = JSON.stringify(fixture);
  const mini = buildProgramPlanView(fixture);
  const html = renderProgramPlan(fixture, program);
  const cells = [...html.matchAll(/<a class="plan-cell [^>]*data-plan-select="(\d+)"[^>]*>([\s\S]*?)<\/a>/g)];
  assert.equal(cells.length, examples.length);
  for (const [i, example] of examples.entries()) {
    assert.equal(mini.days[i].marker, example.marker);
    assert.equal(cells[i][2].match(/<i[^>]*>([^<]*)<\/i>/)[1], example.marker);
    if (example.marker === '-') {
      assert.equal(mini.days[i].statusLabel, '-');
      assert.match(cells[i][2], /<small>-<\/small>/);
      assert.match(html, new RegExp(`id="program-day-${i + 1}"[\\s\\S]*?<summary><b>Day ${i + 1}</b><span>-</span>`));
    }
  }
  assert.equal(mini.days[27].marker, '-');
  assert.ok(!/[动提实—·]/.test(mini.days.map((day) => day.marker).join('')));
  assert.equal(JSON.stringify(fixture), before);
});

// 隔离源码变异，不触碰实际文件；每个新增用例都须能拦住对应反例。
for (const [index, [name, run, from, to]] of cases.entries()) {
  assert.ok(rendererSource.includes(from), '反例必须命中实际源码');
  const source = rendererSource.replace(from, to).replace(/from (['"])(\.[^'"]+)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, rendererUrl).href}${quote}`);
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(source + `\n// mutant ${index}`).toString('base64'));
  assert.throws(() => run(mutant.renderProgramPlan), undefined, '反例未被拦截: ' + name);
}

const selectionScript = template.match(/<script>\s*(\(function \(\) \{\s*var plan = document.querySelector\('\.program-plan'\);[\s\S]*?)<\/script>/)[1];
function boot(script, hash = '') {
  const make = day => {
    const classes = new Set(day === '2' ? ['is-selected'] : []), attrs = {};
    return { dataset: { planDay: day, planSelect: day }, open: day === '2', classes,
      classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); } },
      addEventListener(name, fn) { this.click = fn; }, setAttribute(name, value) { attrs[name] = value; }, removeAttribute(name) { delete attrs[name]; },
      getAttribute() { return '#program-day-' + day; } };
  };
  const days = ['1', '2', '28'].map(make), links = ['1', '2', '28'].map(make);
  const root = { classList: { add() {} }, querySelectorAll(selector) { return selector === '[data-plan-day]' ? days : links; } };
  const history = { replaceState(a,b,value) { this.hash = value; } };
  vm.runInNewContext(script, { document: { querySelector() { return root; } }, history, location: { hash } });
  return { days, links, history };
}
const selectionCases = [
  ['点击活动日同步唯一明细与高亮', script => {
    const page = boot(script); page.links[2].click({ preventDefault() {} });
    assert.deepEqual(page.days.filter(d => d.open && d.classes.has('is-selected')).map(d => d.dataset.planDay), ['28']);
  }, "box.classList.toggle('is-selected', active);", "box.classList.toggle('is-selected', false);"],
  ['分享或刷新保留选中活动日', script => {
    assert.equal(boot(script, '#program-day-1').days.find(d => d.open).dataset.planDay, '1');
  }, 'if (requested) select(requested[1]);', ''],
  ['无效活动日不清空当前明细', script => {
    assert.equal(boot(script, '#program-day-99').days.find(d => d.open).dataset.planDay, '2');
  }, "if (!days.some(function (box) { return box.dataset.planDay === day; })) return;", ''],
];
for (const [name, run, from, to] of selectionCases) {
  check(name, () => run(selectionScript));
  assert.throws(() => run(selectionScript.replace(from, to)), undefined, '反例未被拦截: ' + name);
}

const now = Date.parse('2026-10-22T02:00:00Z');
const records = Array.from({ length: 30 }, (_, i) => ({ announced_at: new Date(now - (70 - i * 2) * 86400000).toISOString(), type: 'reset', text: 'Done' }));
const derived = derive({ resets: { records }, tweets: { tweets: [] }, statsFile: {}, now, account: 'thsottiaux' });
const signal = { ...derived.signals, calendar: { plan, cells: [], fromDate: '2026-10-05', toDate: '2026-11-01', progressDay: 18, days: 28, confirmedCount: 0, resetCount: 0, creditCount: 0, pendingCount: 0 }, activeHints: [{ createdAt: '2026-10-22T01:00:00Z', text: 'Credit clue', window: {}, level: 'hint' }], forecasts: [], counts: { hint: 1 }, checkedTweets: 1 };
const verifyIntegration = render => {
  const parts = render(derived.model, derived.prediction, signal);
  assert.ok(parts.PROGRAM.includes('data-plan-day="2"') && parts.SIGNAL.includes('class="am-signal-details is-hint"'));
};
check('实际页面接入逐日计划并把线索原文收进可展开详情', () => verifyIntegration(renderAll));
for (const [from, to] of [
  ['renderProgramPlan(signals?.calendar?.plan, signals?.program)', 'renderProgram(signals?.program)'],
  ['class="am-signal-details is-hint"', 'class="sig"'],
]) {
  const source = rendererSource.replace(from, to).replace(/from (['"])(\.[^'"]+)\1/g, (_, q, path) => `from ${q}${new URL(path, rendererUrl).href}${q}`);
  const broken = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.throws(() => verifyIntegration(broken.renderAll));
}
const verifyPlacement = source => assert.ok(source.indexOf('<!--__SIGNAL__-->') < source.indexOf('<!--__OUTLOOK__-->') && source.indexOf('<!--__OUTLOOK__-->') < source.indexOf('<!--__PROGRAM__-->') && source.indexOf('<!--__PROGRAM__-->') < source.indexOf('<!--__RESET_CALENDAR__-->'));
check('线索置顶且计划留在主栏', () => verifyPlacement(template));
assert.throws(() => verifyPlacement(template.replace('        <!--__PROGRAM__-->\n', '').replace('<!--__BASIS_SUMMARY__-->', '<!--__BASIS_SUMMARY__--><!--__PROGRAM__-->')));

const rhythmData = { gapDays: Array.from({ length: 20 }, (_, i) => i / 2),
  records: Array.from({ length: 21 }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, i + 1)).toISOString() })) };
const pointCount = scene => scene.elements.filter(e => e.k === 'circle' && e.r < 4).length;
const sceneCases = [
  ['宽屏可显示最近14次真实间隔', fn => {
    assert.equal(pointCount(fn(rhythmData, { width: 1096, height: 280, count: 14 })), 14);
  }, '.slice(-count)', '.slice(-7)'],
  ['未传条数仍保留小程序的最近7次', fn => {
    assert.equal(pointCount(fn(rhythmData)), 7);
  }, 'Math.min(28, opts.count) : 7', 'Math.min(28, opts.count) : 14'],
  ['各尺寸绘图区的左右留白一致', fn => {
    for (const width of [200, 246, 310, 490, 1096]) {
      const scene = fn(rhythmData, { width, count: width > 699 ? 14 : 7 });
      const points = scene.elements.filter(e => e.k === 'circle' && e.r < 4);
      assert.equal(points[0].cx, width - points.at(-1).cx);
    }
  }, 'R = L, T = 22', 'R = 18, T = 22'],
  ['宽图较大字号、零值与空数据都不越界', fn => {
    for (const input of [rhythmData, { gapDays: [0], records: rhythmData.records.slice(-1) }, { gapDays: [], records: [] }]) {
      const b = sceneBounds(fn(input, { width: 1096, height: 280, fontScale: 1.5, count: 14 }));
      assert.ok(b.minX >= 0 && b.minY >= 0 && b.maxX <= 1096 && b.maxY <= 280);
    }
  }, 'Math.max(12, size)', '12'],
];
for (const [name, run, from, to] of sceneCases) {
  check(name, () => run(rhythmScene));
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(sceneSource.replace(from, to)).toString('base64'));
  assert.throws(() => run(mutant.rhythmScene), undefined, '反例未被拦截: ' + name);
}
const rhythmRenderCase = fn => {
  const html = fn(rhythmData);
  const wide = html.match(/<svg class="am-trend am-trend-wide"[\s\S]*?<\/svg>/)[0];
  assert.equal([...wide.matchAll(/<circle[^>]+r="(?:2\.5|3\.5)"/g)].length, 14);
};
check('网页宽图实际接入14次范围', () => rhythmRenderCase(renderRecentRhythm));
const rhythmRenderMutant = rendererSource.replace('height: 280, count: 14', 'height: 280, count: 7')
  .replace(/from (['"])(\.[^'"]+)\1/g, (_, q, path) => `from ${q}${new URL(path, rendererUrl).href}${q}`);
const brokenRhythm = await import('data:text/javascript;base64,' + Buffer.from(rhythmRenderMutant).toString('base64'));
assert.throws(() => rhythmRenderCase(brokenRhythm.renderRecentRhythm));
const verifyCaption = fn => assert.ok(fn(derived.model, derived.prediction, signal).RHYTHM_CAPTION.includes('最近 14 次间隔'));
check('宽图标题与实际条数一致', () => verifyCaption(renderAll));
const captionMutant = rendererSource.replace('Math.min(14, m.gapDays.length)', 'Math.min(7, m.gapDays.length)')
  .replace(/from (['"])(\.[^'"]+)\1/g, (_, q, path) => `from ${q}${new URL(path, rendererUrl).href}${q}`);
const brokenCaption = await import('data:text/javascript;base64,' + Buffer.from(captionMutant).toString('base64'));
assert.throws(() => verifyCaption(brokenCaption.renderAll));
assert.equal(digest(await readFile(rendererUrl, 'utf8')), digest(rendererSource));
assert.equal(digest(await readFile(sceneUrl, 'utf8')), digest(sceneSource));
assert.equal(digest(await readFile(new URL('../src/index.html', import.meta.url), 'utf8')), digest(template));
console.log(`\n${checks} 项通过；${cases.length + selectionCases.length + 3 + sceneCases.length + 2} 个隔离反例被拦截，源码哈希未变`);
