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
  // 真实历史记录里的推文 —— 它**就是** 2026-09-12 那次重置本身。
  //
  // 早先的实现把它判成 none（理由写「已完成的过去事件，不是预告」），于是页面
  // 自相矛盾：下方「最近记录」里这条明明标着「普通重置」，上方信号区却说
  // 「没有检测到重置预告」。观测台的主问题就是「上次重置是什么时候」，
  // 把已发生的事实丢掉，等于不回答自己的主问题。
  const r = run('Reset all propagated. Sweet dreams. https://t.co/VgKVUixoJG', '2026-09-12T08:09:17.000Z');
  check('已完成的重置 → occurred（不再当噪音丢弃）', r.level === 'occurred', `实际 ${r.level}`);
  check('occurred 不再带「不是预告」这类排除理由', r.rejected === null, `实际 ${r.rejected}`);
  check('occurred 不给未来窗口（窗口是预告才有的语义）', r.window === null, `实际 ${r.window}`);
  check('occurred 带回发生时刻', r.occurredAt === '2026-09-12T08:09:17.000Z', `实际 ${r.occurredAt}`);
}

{
  // 同一天更早的那条：写着 "A reset"，但**一个额度词都没有**。
  // 旧版双重丢失 —— 词表认不出名词化陈述，且 slice(0,5) 按时间倒序把它截掉。
  const t =
    'Hi Astra users. A reset and a quick update on quality issues that have been posted around. ' +
    'Working with some of you, we have found and fixed the following issues.';
  const r = run(t, '2026-09-12T03:20:36.000Z');
  check('「A reset…」名词化陈述 → occurred', r.level === 'occurred', `实际 ${r.level}`);
}

{
  // 新增判据的反例 —— 放宽了「已发生」的识别面，就必须把误报面同时钉死。
  const cases = [
    ['the model weights reset made training faster', '与额度无关的 reset'],
    ['we will have reset all limits by tomorrow morning', '将来完成时'],
    ['if we did another reset, everyone would lose their banked credits', '假设语境'],
  ];
  for (const [text, label] of cases) {
    const r = run(text, '2026-09-17T17:57:59.000Z');
    check(`${label} 不判 occurred`, r.level !== 'occurred', `实际 ${r.level}（${text.slice(0, 40)}）`);
  }
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

/* ========== 2.7 上下文识别：额度语境常在「被回复的那条推文」里 ========== */

console.log('\n【2.7】上下文识别：他回复别人时，自己这条常常一个额度词都没有');

{
  // 真实场景（2026-09-21）。这条回复单独看是
  //   「OK fine. But it's also still coming in Tuesday」
  // —— 12 个词里没有任何 reset / limits / credits，任何词表都读不出「这是在说重置」。
  // 额度语境在被回复的那条推文里（有人在催 "you owe us a banked reset"）。
  // 修复前这条会以「没有额度相关词」被丢弃，于是官方亲口承诺的重置不会出现在页面上。
  const AT = '2026-09-21T04:41:00.000Z';
  const ctx = {
    account: 'udiWertheimer',
    id: 'ctx1',
    text:
      "ok tibo you guys didn't ship anything interesting this week\n\n" +
      "you owe us a banked reset\n\nsorry i don't make the rules",
    created_at: '2026-09-19T20:00:00.000Z',
  };
  const reply = (extra = {}) => ({
    id: 'r1',
    text: "OK fine. But it's also still coming in Tuesday",
    created_at: AT,
    account: 'thsottiaux',
    inReplyTo: ctx,
    ...extra,
  });

  const withCtx = analyzeTweet(reply(), { sourceZone: SOURCE_ZONE, userZone: USER_ZONE });
  check('带上下文 → 判为明确信号', withCtx.level === 'explicit', `实际 ${withCtx.level}`);
  check('标记为「借上下文」，与他自己说 reset 区分开', withCtx.viaContext === true, `实际 ${withCtx.viaContext}`);
  check(
    '时间取本条（coming in Tuesday → 北京时间 9/22）',
    withCtx.window?.from === '2026-09-22T07:00:00.000Z',
    `实际 ${withCtx.window?.from}`
  );
  check('给得出可追溯的理由', withCtx.reasons.some((s) => s.includes('借自上下文')), `实际 ${withCtx.reasons.join(' | ')}`);

  const noCtx = analyzeTweet(reply({ inReplyTo: null }), { sourceZone: SOURCE_ZONE, userZone: USER_ZONE });
  check(
    '不带上下文 → 不升级（这正是它此前被整条漏掉的原因）',
    noCtx.level !== 'explicit',
    `实际 ${noCtx.level}；${noCtx.rejected}`
  );
}

{
  // 反例一：被回复的推文与额度无关 → 哪怕他说了延续语气也不能借
  const r = analyzeTweet(
    {
      id: 'r2',
      text: 'it is still coming tomorrow',
      created_at: '2026-09-21T04:41:00.000Z',
      account: 'thsottiaux',
      inReplyTo: { account: 'someone', text: 'when will the new mascot drop?', id: 'c2' },
    },
    { sourceZone: SOURCE_ZONE, userZone: USER_ZONE }
  );
  check('上下文无额度语境 → 不借意图', r.level !== 'explicit', `实际 ${r.level}；intent=${r.intent}`);
}

{
  // 反例二：上下文有额度语境，但他这句没有延续语气（只是在答应去看一眼）
  const r = analyzeTweet(
    {
      id: 'r3',
      text: 'will look into it tomorrow',
      created_at: '2026-09-21T04:41:00.000Z',
      account: 'thsottiaux',
      inReplyTo: { account: 'someone', text: 'you owe us a banked reset', id: 'c3' },
    },
    { sourceZone: SOURCE_ZONE, userZone: USER_ZONE }
  );
  check(
    '无延续语气 → 不借意图（will 后面不是「到来」类动词）',
    r.level !== 'explicit',
    `实际 ${r.level}；intent=${r.intent}`
  );
}

{
  // 反例三：上下文里出现 reset，但那是「权重重置让训练更快」这类无关用法。
  // 这一条是收紧上下文档位的直接依据 —— 只看有没有 reset 词，它就会误报。
  const r = analyzeTweet(
    {
      id: 'r4',
      text: 'still coming this week',
      created_at: '2026-09-21T04:41:00.000Z',
      account: 'thsottiaux',
      inReplyTo: { account: 'someone', text: 'the model weights reset made training faster', id: 'c4' },
    },
    { sourceZone: SOURCE_ZONE, userZone: USER_ZONE }
  );
  check(
    '上下文里的 reset 与额度无关 → 不借意图',
    r.level !== 'explicit',
    `实际 ${r.level}；intent=${r.intent}`
  );
}

{
  // 上下文里的时间词**不参与**解析：this week 是提问者的坐标，不是他的承诺时点。
  const r = analyzeTweet(
    {
      id: 'r5',
      text: "OK, it's coming in Tuesday",
      created_at: '2026-09-21T04:41:00.000Z',
      account: 'thsottiaux',
      inReplyTo: {
        account: 'someone',
        text: 'you owe us a banked reset this week, come on',
        id: 'c5',
      },
    },
    { sourceZone: SOURCE_ZONE, userZone: USER_ZONE }
  );
  check('时间只从本条取，不借上下文的时间词', (r.timeWord ?? '').toLowerCase().includes('tuesday'), `实际 ${r.timeWord}`);
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

  // 「真实数据里不该有明确预告」是个**过时的期望**：它固化的是「当时没采到预告」
  // 这个数据事实，而不是一条规则。他是真的会预告的 —— 2026-09-22 那条
  // 「Ladies and gentlemen... start... your... ENGINES. We are almost Tuesday
  // and I promised a reset」就是硬预告。
  //
  // 所以要钉的是**预告的准入条件**，不是「不许有预告」：
  // 凡是判成 explicit 的，必须能给出可复核的时间窗口与判定依据。
  // 没有窗口的「快了」不算预告 —— 那会变成制造焦虑的假信号。
  check(
    '明确预告必须都给得出时间窗口（空话不算预告）',
    sig.signals.every((s) => !!s.window),
    sig.signals.map((s) => `${s.id}:${!!s.window}`).join(',')
  );
  check(
    '明确预告必须给出判定依据（不只给结论）',
    sig.signals.every((s) => (s.reasons ?? []).length > 0),
    sig.signals.map((s) => s.id).join(',')
  );

  // 回复带来的上下文必须写进依据里 —— 「很多消息在回复里」这件事的落点，
  // 判错了会让「他的半句话」被当成无关推文丢掉。
  const replied = [
    ...(sig.signals ?? []),
    ...(sig.occurred ?? []),
    ...(sig.hints ?? []),
  ].filter((s) => s.inReplyTo);
  check(
    '带被回复内容的推文，判定依据里必须写明上下文',
    replied.every((s) => (s.reasons ?? []).some((r) => String(r).includes('上下文'))),
    `${replied.length} 条带上下文`
  );

  const within = tweets.filter(
    (t) =>
      t.created_at &&
      NOW - new Date(t.created_at).getTime() <= 60 * 864e5 &&
      // ⚠ 上界同样是窗口的一部分：晚于 now 的推文是「本轮之后才发生的」，
      // 不参与本轮判断。测试用的是一个固定 NOW（2026-09-20），而库里已经有
      // 更晚的推文，漏掉这个上界就会把「正确地跳过 6 条」读成「少扫了 6 条」。
      new Date(t.created_at).getTime() <= NOW &&
      t.text
  ).length;
  check(
    '只扫描时间窗口内的推文（下界 60 天、上界 now）',
    sig.checkedTweets === within,
    `${sig.checkedTweets} vs 窗口内 ${within}（文件共 ${tweets.length} 条）`
  );
  check('给出当前时差说明', typeof sig.zones?.diffText === 'string' && sig.zones.diffText.length > 0, sig.zones?.diffText);

  // 每一条被扫描的推文都必须落进四类之一。
  // 旧版对每类各取 slice(0, 5)，而列表按时间倒序 —— 被丢掉的恰好是最靠近
  // 「上一次重置」的那几条。实测 16 条里静默吞掉 6 条。
  const sum = sig.counts.explicit + sig.counts.occurred + sig.counts.hint + sig.counts.none;
  check('四类计数之和 = 扫描条数（不静默丢）', sum === sig.counts.scanned, `${sum} vs ${sig.counts.scanned}`);
  check('触顶状态是显式的', typeof sig.truncated === 'boolean', `实际 ${typeof sig.truncated}`);

  // 真实数据里的两条重置（09-12 的 03:20 与 08:09）都要被认出来。
  // 它们此前一条被判 none、一条被截断，本轮修复的核心回归点。
  check('真实数据里的两条重置都被认出', sig.occurred.length === 2, `实际 ${sig.occurred.length}`);

  console.log(`    真实数据结论：level=${sig.level}，明确信号 ${sig.signals.length} 条，已发生 ${sig.occurred.length} 条，线索 ${sig.hints.length} 条，排除 ${sig.rejected.length} 条`);
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
