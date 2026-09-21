#!/usr/bin/env node
/**
 * 信号识别的用例测试。
 *
 * 为什么这个测试必须存在：这个功能**误报一次就废了**。
 * 项目里现成有一条真实推文含 "next week"，但讲的是发布延期 ——
 * 如果它被标成「重置信号」，用户会照着它去等一个不存在的重置。
 * 所以下面的用例里既测「该报的必须报」，也测「不该报的绝对不能报」。
 *
 * 运行：node scripts/test-signals.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTweet, detectSignals, SOURCE_ZONE, USER_ZONE } from '../src/lib/signals.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const fails = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const run = (text, at, id = '1') =>
  analyzeTweet({ id, text, created_at: at, account: 'thsottiaux' }, {
    sourceZone: SOURCE_ZONE,
    userZone: USER_ZONE,
  });

/* ============================ 1. 该报的必须报 ============================ */

console.log('\n【1】明确信号：必须识别出等级、窗口，并给出双时区');

{
  // 真实场景原型：周四发推，说下周二重置
  const T = '2026-09-17T17:57:59.000Z';
  const r = run("We'll reset everyone's usage limits next Tuesday.", T);
  check('等级 = explicit', r.level === 'explicit', `实际 ${r.level}`);
  check('时间词识别 = next tuesday', (r.timeWord ?? '').includes('tuesday'), `实际 ${r.timeWord}`);
  check(
    '窗口起点 = 2026-09-22T07:00Z（洛杉矶 9/22 00:00）',
    r.window?.from === '2026-09-22T07:00:00.000Z',
    `实际 ${r.window?.from}`
  );
  check(
    '换算到北京时间跨自然日（9/22 15:00 → 9/23 14:59）',
    r.window?.crossesUserDay === true && r.window.userZone.includes('15:00') && r.window.userZone.includes('14:59'),
    `实际 ${r.window?.userZone}`
  );
  check(
    '时区说明含 15 小时时差',
    r.window?.zones?.diffText?.includes('15'),
    `实际 ${r.window?.zones?.diffText}`
  );
  check('给出原推链接', (r.url ?? '').endsWith('/status/1'), `实际 ${r.url}`);
}

{
  const r = run('resetting all usage limits in 2 hours', '2026-09-17T17:57:59.000Z');
  check('相对时间 in 2 hours 解析正确', r.level === 'explicit' && r.window?.from === '2026-09-17T19:57:59.000Z', `实际 ${r.level} ${r.window?.from}`);
}

{
  const r = run('banked credits for everyone next week', '2026-09-17T17:57:59.000Z');
  check('发券型重置（banked credits）也识别', r.level === 'explicit', `实际 ${r.level}`);
  check('next week 窗口 = 下一个自然周整周', r.window?.from === '2026-09-21T07:00:00.000Z', `实际 ${r.window?.from}`);
}

{
  const r = run("tomorrow we're giving everyone a fresh set of limits", '2026-09-17T17:57:59.000Z');
  check('「fresh set of limits + tomorrow」算明确信号', r.level === 'explicit', `实际 ${r.level}`);
  check('tomorrow = 洛杉矶 9/18 00:00', r.window?.from === '2026-09-18T07:00:00.000Z', `实际 ${r.window?.from}`);
}

{
  const r = run('fresh quota for all of you tonight', '2026-09-17T17:57:59.000Z');
  check('tonight 解析成当晚时段', r.level === 'explicit' && r.precision === 'evening', `实际 ${r.level} ${r.precision}`);
}

/* ==================== 2. 不该报的绝对不能报（核心回归） ==================== */

console.log('\n【2】反例：绝不能误报');

{
  // 真实历史记录里的推文，属于「已经发生」
  const r = run('Reset all propagated. Sweet dreams. https://t.co/VgKVUixoJG', '2026-09-12T08:09:17.000Z');
  check('已完成的过去事件不报信号', r.level === 'none', `实际 ${r.level}；理由 ${r.rejected}`);
}

{
  // 真实推文：含 next week，但讲的是发布延期
  const r = run(
    'the main thing i was excited about launching this week will be next week instead, but imo worth the wait!',
    '2026-09-17T17:57:59.000Z'
  );
  check('发布延期的推文不升级为明确信号', r.level !== 'explicit', `实际 ${r.level}`);
  check('且给出可追溯的排除理由', typeof r.rejected === 'string' && r.rejected.length > 0, `实际 ${r.rejected}`);
}

{
  const r = run('we are adjusting usage limits to make them fairer', '2026-09-17T17:57:59.000Z');
  check('只谈「调整额度」且无时间 → 不是明确信号', r.level !== 'explicit', `实际 ${r.level}`);
}

{
  const r = run('Has anyone tried Astra and Fable on the same styleguide?', '2026-09-17T17:57:59.000Z');
  check('完全无关的推文 → none', r.level === 'none', `实际 ${r.level}`);
}

{
  const r = run('Shipping a new model next Tuesday', '2026-09-17T17:57:59.000Z');
  check('发新模型 + 时间 → 不是重置信号', r.level !== 'explicit', `实际 ${r.level}`);
}

/* ============ 2.5 KI-001 回归：多个时间表达时不得挑到更含糊的那个 ============ */

console.log('\n【2.5】KI-001 回归：时间表达的选取顺序');

{
  // 句子主体是 next Tuesday，weekend 只是寒暄。
  // 修复前按「窗口开始得早」排，weekend（9/19）会压过 next Tuesday（9/22）。
  const T = '2026-09-18T18:00:00.000Z'; // 洛杉矶 9/18 周五
  const r = run("Good news: we will reset everyone's usage limits next Tuesday. Enjoy the weekend.", T);
  check('KI-001：等级仍为 explicit', r.level === 'explicit', `实际 ${r.level}`);
  check('KI-001：时间词取 next tuesday 而非 weekend', (r.timeWord ?? '').includes('tuesday'), `实际 ${r.timeWord}`);
  check(
    'KI-001：窗口 = 9/22，不是已经过去的 9/19 周末',
    r.window?.from === '2026-09-22T07:00:00.000Z',
    `实际 ${r.window?.from}`
  );
}

{
  // 同一句话，但发推时点挪到周日晚上 —— 此时周末已经过去大半，
  // 修复前「end 晚于现在」的宽松判定仍会把周末算成未来窗口。
  const r = run(
    "Good news: we will reset everyone's usage limits next Tuesday. Enjoy the weekend.",
    '2026-09-21T03:00:00.000Z' // 洛杉矶 9/20 20:00 周日
  );
  check('KI-001：含糊窗口已过半被剔除，主解读仍是 9/22', r.window?.from === '2026-09-22T07:00:00.000Z', `实际 ${r.window?.from}`);
}

{
  // 只含「已经过去大半的那个周末」的推文，不得产出未来窗口
  const r = run('Enjoy the weekend — big things coming.', '2026-09-21T03:00:00.000Z');
  check('KI-001：只说周末且该周末已过半 → 无未来窗口', r.window === null, `实际 ${JSON.stringify(r.window)}`);
  check('KI-001：且不得升级为信号', r.level !== 'explicit', `实际 ${r.level}`);
}

{
  // 反向保护：没有更具体表达时，weekend 仍应正常作候选（不能一刀切禁掉）
  const r = run("we'll reset everyone's limits this weekend", '2026-09-17T17:57:59.000Z');
  check('含糊表达在无更具体表达时仍可用', r.level === 'explicit' && r.timeWord === 'weekend', `实际 ${r.level} / ${r.timeWord}`);
}

{
  // 具体表达优先于含糊表达：tomorrow 压过 weekend
  const r = run("resetting all limits tomorrow. Enjoy the weekend.", '2026-09-18T18:00:00.000Z');
  check('tomorrow 压过 weekend', r.timeWord === 'tomorrow', `实际 ${r.timeWord}`);
  check('且窗口落在 9/19', r.window?.from === '2026-09-19T07:00:00.000Z', `实际 ${r.window?.from}`);
}

/* ==================== 3. 相对时间词的歧义必须标注 ==================== */

console.log('\n【3】歧义处理：英文相对时间词');

{
  // 周一发推说 next Tuesday：主解读应为下个自然周的周二（9/29），
  // 另一种解读是最近的周二（9/22），必须一并标注
  const r = run("we'll reset the limits next Tuesday", '2026-09-21T16:00:00.000Z');
  check('周一说的 next Tuesday 主解读 = 9/29', r.window?.from === '2026-09-29T07:00:00.000Z', `实际 ${r.window?.from}`);
  check('标注了另一种解读', (r.timeNote ?? '').includes('另一种解读'), `实际 ${r.timeNote}`);
}

{
  // 周四说 this Tuesday → 最近的周二（9/22），没有歧义
  const r = run("we'll reset the limits this Tuesday", '2026-09-17T17:57:59.000Z');
  check('this Tuesday 取最近的周二 = 9/22', r.window?.from === '2026-09-22T07:00:00.000Z', `实际 ${r.window?.from}`);
}

{
  const r = run('resetting all limits on October 3', '2026-09-17T17:57:59.000Z');
  check('具体月份日期解析 = 10/03', r.window?.from === '2026-10-03T07:00:00.000Z', `实际 ${r.window?.from}`);
}

{
  const r = run('resetting all limits on 2026-10-05', '2026-09-17T17:57:59.000Z');
  check('ISO 日期解析 = 10/05', r.window?.from === '2026-10-05T07:00:00.000Z', `实际 ${r.window?.from}`);
}

/* ============================ 4. 汇总与真实数据 ============================ */

console.log('\n【4】汇总接口 + 真实数据回归');

{
  const tweets = JSON.parse(await readFile(resolve(ROOT, 'data/tweets.json'), 'utf8')).tweets;
  const NOW = new Date('2026-09-20T10:00:00.000Z').getTime();
  const sig = detectSignals(tweets, { now: NOW });

  check('真实快照下不产生误报的明确信号', sig.level !== 'explicit', `实际 ${sig.level}`);
  const within = tweets.filter(
    (t) => t.created_at && NOW - new Date(t.created_at).getTime() <= 60 * 864e5
  ).length;
  check(
    '只扫描时间窗口内的推文',
    sig.checkedTweets === within,
    `${sig.checkedTweets} vs 窗口内 ${within}（文件共 ${tweets.length} 条，其中 ${tweets.length - within} 条超出 60 天）`
  );
  check('给出当前时差说明', typeof sig.zones?.diffText === 'string' && sig.zones.diffText.length > 0, sig.zones?.diffText);
  console.log(`    真实数据结论：level=${sig.level}，明确信号 ${sig.signals.length} 条，线索 ${sig.hints.length} 条，排除 ${sig.rejected.length} 条`);
}

{
  const now = new Date('2026-09-20T10:00:00.000Z').getTime();
  const tweets = [
    { id: '9', text: "We'll reset everyone's limits next Tuesday.", created_at: '2026-09-19T18:00:00.000Z' },
    { id: '8', text: 'the launch slipped to next week', created_at: '2026-09-18T18:00:00.000Z' },
  ];
  const sig = detectSignals(tweets, { now });
  check('多推文时取最新的一条作主结论', sig.latest?.id === '9', `实际 ${sig.latest?.id}`);
  check('汇总等级 = explicit', sig.level === 'explicit', `实际 ${sig.level}`);
  check('明确信号只有 1 条', sig.signals.length === 1, `实际 ${sig.signals.length}`);
}

/* ================================ 结果 ================================ */

console.log(`\n${'─'.repeat(56)}`);
if (fails.length) {
  console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部通过（${pass} 项）`);
