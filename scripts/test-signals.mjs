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

import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTweet, detectSignals, latestEventMs, hasOccurredPart, detectProgram, SOURCE_ZONE, USER_ZONE } from '../src/lib/signals.mjs';
import { renderSignal } from '../src/lib/render.mjs';

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
  // D-019：窗口文案按**粒度**定形，具体时刻优先，区间只在时间本来就含糊时出现。
  // 这一条是「只说到天」的情形 —— 当地写「全天」，北京只给**开启那一刻**，
  // 跨自然日这个事实退到 rangeNote 里说一句。
  //
  // 旧版是「当地 00:00 – 23:59 / 北京 15:00 → 次日 14:59」：把天粒度硬展开成钟点
  // 区间（读起来像他定在午夜），又把北京那行的具体时刻夹在跨日箭头里。
  check(
    '「只说到天」：当地写「全天」，不展开成钟点区间',
    r.window?.sourceZone === '2026.09.22（周二） 全天',
    `实际 ${r.window?.sourceZone}`
  );
  check(
    '「只说到天」：北京只给开启那一刻（含倒计时锚点 openText）',
    r.window?.userZone === '2026.09.22（周二）15:00 起' &&
      r.window?.openText === '2026.09.22（周二）15:00',
    `实际 ${r.window?.userZone} / ${r.window?.openText}`
  );
  check(
    '跨自然日退到 rangeNote，不再占主位',
    r.window?.rangeNote === '窗口到北京 2026.09.23（周三）14:59 为止' &&
      r.window?.crossesUserDay === true,
    `实际 ${r.window?.rangeNote} / crosses=${r.window?.crossesUserDay}`
  );
  check(
    '时区说明含 15 小时时差',
    r.window?.zones?.diffText?.includes('15'),
    `实际 ${r.window?.zones?.diffText}`
  );
  check('给出原推链接', (r.url ?? '').endsWith('/status/1'), `实际 ${r.url}`);
}

{
  // 真到了钟点 → 两边各给**一个时刻**，不摆区间（D-019）。
  const r = run("We'll reset everyone's usage limits at 3am on Tuesday.", '2026-09-17T17:57:59.000Z');
  check(
    '「星期 + 钟点」以钟点为准 → 精度 instant',
    r.level === 'explicit' && r.precision === 'instant',
    `实际 ${r.level} / ${r.precision}`
  );
  check(
    '有时刻：当地 03:00、北京 18:00，各一个时刻',
    r.window?.sourceZone === '2026.09.22（周二）03:00' &&
      r.window?.userZone === '2026.09.22（周二）18:00',
    `实际 ${r.window?.sourceZone} / ${r.window?.userZone}`
  );
  check(
    '有时刻时没有 rangeNote —— 区间说明只服务于「收敛过」的窗口',
    !r.window?.rangeNote,
    `实际 ${r.window?.rangeNote}`
  );
}

{
  // 整周与「只说到天」相反：时间**本来就含糊**，这时候区间才是诚实的表达。
  // 一刀切成单点会让页面报出一个他不认得的时刻。
  const r = run('banked credits for everyone next week', '2026-09-17T17:57:59.000Z');
  check(
    '整周仍用区间（含糊粒度不假装精确）',
    typeof r.window?.sourceZone === 'string' &&
      (r.window.sourceZone.includes('–') || r.window.sourceZone.includes('→')),
    `实际 ${r.window?.sourceZone}`
  );
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

/* -------- 2.2 否定 / 备选语境：2026-10-07 从真实语料里抓到的两条假阳性 --------
 *
 * 两条都是「冠词 + reset」这条**弱证据**在没有人拦的情况下直接升级成既成事实。
 * 它们的共同点是**语义与结论相反或无关**，而且都是高置信度误报 ——
 * conf 0.86 的 occurred 说「他刚才重置了」，而那句话原意是「我没法给重置」。
 * 这正是本模块最不能出的错（假信号比漏检更伤可信度），所以两条都必须钉在这儿。
 */
{
  // ① 被否定：他说的是「给不了」。
  const denied =
    'Because usage on your primary dot is virtually unlimited at the moment, ' +
    'I can’t really give a reset. I need to come up with something new fast.';
  const r1 = run(denied, '2026-10-01T14:51:54.000Z');
  check('被否定的 reset（can’t really give a reset）不判 occurred', r1.level !== 'occurred', `实际 ${r1.level}`);
  check('它也不被反过来升级成预告', r1.level !== 'explicit', `实际 ${r1.level}`);

  // ② 备选项：在复述「每天要么给改进、要么给完整重置」这条规则，是回顾不是宣告。
  const either = 'Four updates or a reset. Or both. How was day 2.';
  const r2 = run(either, '2026-10-06T21:07:55.000Z');
  check('把 reset 摆成备选项（N or a reset）不判 occurred', r2.level !== 'occurred', `实际 ${r2.level}`);
  check('它也不被升级成预告（没有时间窗）', r2.level !== 'explicit', `实际 ${r2.level}`);

  // ③ 同族形态：`either … or`，且句中**一个未来语气词都没有**。
  //    这条是刻意的：10-04 那条真实推文里带着 "we'll"，会被 `RE_FUTURE` 提前拦下，
  //    所以它**证明不了**这道新闸门有效 —— 恒绿的断言等于没有断言。
  //    去掉未来语气才真正压到 `RE_ANNOUNCE` 这条弱证据上。
  const eitherOr = 'Each day we ship an improvement or a reset.';
  const r3 = run(eitherOr, '2026-10-04T20:33:43.000Z');
  check('either/or 备选（无未来语气）不判 occurred', r3.level !== 'occurred', `实际 ${r3.level}`);

  // ③b 真实语料形状回归：10-04 那条 28 天计划原文。
  //    它由 `RE_FUTURE` 拦（"we'll" 在表里），**与本次闸门无关** ——
  //    留着它防的是将来有人把未来语气表改松。标注清楚，免得被当成这道闸门的功劳。
  const plan =
    'Over the next 28 days, each day we’ll either ship one thing that is a clear ' +
    'improvement and relevant for most codex/work users or ship a full reset.';
  const r4 = run(plan, '2026-10-04T20:33:43.000Z');
  check('28 天计划原文不判 occurred（由未来语气拦，见注释）', r4.level !== 'occurred', `实际 ${r4.level}`);

  // ④ **反向兜底**：强证据不受这道闸门影响。
  //    没有这条，「只拦弱证据」就只是注释里的一句话，没人证明过 ——
  //    而收紧误报最容易连带把真事实一起收掉。
  for (const [text, label] of [
    ['Resets all propagated. Or so I’m told. https://t.co/x', '完成句式 + 句尾的 or'],
    ['Reset all propagated. No issues reported.', '完成句式 + 句中的 No'],
    ['Everyone’s limits have been reset. Never seen them this happy.', '被动完成 + Never'],
  ]) {
    const r = run(text, '2026-10-02T21:18:48.000Z');
    check(`${label} 仍判 occurred（强证据优先）`, r.level === 'occurred', `实际 ${r.level}（${text.slice(0, 40)}）`);
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

/* ==================== 3b. 钟点：与同句的日期是一个整体 ==================== */

console.log('\n【3b】钟点解析：3am / 11pm / midnight');

{
  // 本轮的起因。老大的原话：「他不是都有 3am on a tuesday 这样的回复了吗，
  // 为什么没有明确时间？」此前解析器**没有钟点维度** —— 最深只走到
  // 「星期 → 全天」，句子里那个 3am 被整段忽略，精度永远停在 `day`。
  const T = '2026-09-17T17:57:59.000Z'; // 周四，当地 10:57
  const r = run("we'll reset everyone's usage limits at 3am on Tuesday", T);
  check('钟点识别为 instant 精度（不再退化成全天）', r.precision === 'instant', `实际 ${r.precision}`);
  check(
    '钟点钉在**同句的**那一天上 = 9/22 当地 03:00',
    r.window?.from === '2026-09-22T10:00:00.000Z',
    `实际 ${r.window?.from}`
  );
  check('时间词 = 3am', r.timeWord === '3am', `实际 ${r.timeWord}`);
}

{
  const r = run("we'll reset everyone's usage limits at 11pm on Tuesday", '2026-09-17T17:57:59.000Z');
  check(
    '11pm 同样钉在那一天 = 9/22 当地 23:00',
    r.window?.from === '2026-09-23T06:00:00.000Z',
    `实际 ${r.window?.from}`
  );
}

{
  // 句中**没有**日期时，钟点才自行取「最近的未来那一刻」。
  // 发推时当地是 09-17 10:57，当天 3am 已过 → 落在 09-18 03:00。
  const r = run("we'll reset everyone's usage limits at 3am", '2026-09-17T17:57:59.000Z');
  check(
    '无日期时钟点取最近的未来那一刻 = 9/18 当地 03:00',
    r.window?.from === '2026-09-18T10:00:00.000Z',
    `实际 ${r.window?.from}`
  );
}

{
  const r = run("we'll reset everyone's usage limits at midnight", '2026-09-17T17:57:59.000Z');
  check(
    'midnight = 最近的未来零点（当地 9/18）',
    r.window?.from === '2026-09-18T07:00:00.000Z',
    `实际 ${r.window?.from}`
  );
}

{
  // ⚠ 本轮的核心回归，两个方向必须同时成立：
  //   ① 钟点**不能**把没有额度语境的推文送上信号位 —— 09-21 那句
  //      「3am on a tuesday」说的是别人的活动（GPT-6 社区之夜），不是承诺；
  //   ② 但那条时间线索**必须保留**（candidateWindow）。旧实现到这里直接
  //      `window: null`，等于把「系统看到了什么时间」抹掉 —— 事后既无法
  //      复核、也无法参与聚合。老大问的正是「为什么没有明确时间」，
  //      如果连线索都不留，就答不出「看见了但没采信」与「根本没看见」的区别。
  const r = run('3am on a tuesday', '2026-09-21T06:26:00.000Z');
  check('无额度语境的钟点 → 不是明确信号', r.level !== 'explicit', `实际 ${r.level}`);
  check('但时间线索被保留（不静默丢弃）', !!r.candidateWindow, JSON.stringify(r.candidateWindow));
  check(
    '保留的线索带精度与目标日 = 9/22 当地',
    r.candidateWindow?.precision === 'instant' &&
      r.candidateWindow?.dayNum === Date.UTC(2026, 8, 22) / 86_400_000,
    JSON.stringify({ precision: r.candidateWindow?.precision, dayNum: r.candidateWindow?.dayNum })
  );
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
  check(
    'counts.rejected 是未截断的真实总数',
    sig.counts.rejected >= sig.rejected.length,
    `counts ${sig.counts.rejected} vs 保留 ${sig.rejected.length}`
  );
  // 上限的**方向**：`slice(0, N)` 在倒序列表上保留的是最近的那批。
  // 钉住方向，防止将来被改成保留最早的 —— 那会把窗内最新、最该被复核的排查
  // 材料丢掉，留下最旧的，正好反了。
  if (sig.rejected.length >= 2) {
    const head = sig.rejected[0].createdAt;
    const tail = sig.rejected[sig.rejected.length - 1].createdAt;
    check(
      '排除项按时间倒序（触顶时丢的是最旧的）',
      Date.parse(head) > Date.parse(tail),
      `首 ${head} / 末 ${tail}`
    );
  }

  // 真实数据里的两条重置（09-12 的 03:20 与 08:09）都要被认出来。
  // 它们此前一条被判 none、一条被截断，本轮修复的核心回归点。
  check('真实数据里的两条重置都被认出', sig.occurred.length === 2, `实际 ${sig.occurred.length}`);

  console.log(`    真实数据结论：level=${sig.level}，明确信号 ${sig.signals.length} 条，已发生 ${sig.occurred.length} 条，线索 ${sig.hints.length} 条，排除 ${sig.rejected.length} 条`);
}

/* ---------------------- 留档上限（MAX_LISTED）的行为 ---------------------- */
// 上限是纯体积保护，但**数值与方向**都必须钉住 —— 它决定「触顶时丢掉什么」。
// 方向反了就会把窗内最新、最该被复核的排查材料丢掉，留下最旧的。
{
  const now = Date.parse('2026-09-20T10:00:00.000Z');
  const make = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `bulk-${i}`,
      text: 'just a random thought',
      created_at: new Date(now - i * 3_600_000).toISOString(),
    }));

  const atCap = detectSignals(make(200), { now });
  check(
    '恰好 200 条：不触顶',
    atCap.truncated === false && atCap.rejected.length === 200,
    `truncated=${atCap.truncated}，保留 ${atCap.rejected.length} 条`
  );

  const overCap = detectSignals(make(201), { now });
  check('201 条：只保留 200 条', overCap.rejected.length === 200, `实际 ${overCap.rejected.length}`);
  check('201 条：counts.rejected 仍报真实总数 201', overCap.counts.rejected === 201, `实际 ${overCap.counts.rejected}`);
  check('201 条：触顶为 true', overCap.truncated === true, `实际 ${overCap.truncated}`);
  // 关键方向判据：丢掉的必须是**最旧的** bulk-200，保留首条 bulk-0（最新）。
  check(
    '201 条：丢的是最旧的 1 条（首尾 id 钉死方向）',
    overCap.rejected[0].id === 'bulk-0' && overCap.rejected[199].id === 'bulk-199',
    `首 ${overCap.rejected[0].id} / 末 ${overCap.rejected[199].id}`
  );
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

/* ==================== 5. 跨推文聚合（综合分析） ==================== */

console.log('\n【5】跨推文聚合：同一天的多条线索要收在一起');

const DAY_922 = Date.UTC(2026, 8, 22) / 86_400_000;

{
  const now = new Date('2026-09-22T04:40:00.000Z').getTime();
  const tweets = [
    // 硬证据：他承诺了周二（09-22 当地 21:31 发）
    { id: 'h1', text: 'I promised a reset for Tuesday', created_at: '2026-09-22T04:31:00.000Z' },
    // 软证据：同一天的钟点线索，但语境是别人的活动
    { id: 's1', text: '3am on a tuesday', created_at: '2026-09-21T06:26:00.000Z' },
    // 软证据：同一天的钟点，语境是他的作息
    { id: 's2', text: '11pm on a Tuesday, big startup energy', created_at: '2026-09-16T07:14:00.000Z' },
    // 干扰项：另一天的钟点线索，绝不能混进来
    { id: 'x1', text: 'see you Thursday at 9am', created_at: '2026-09-17T06:00:00.000Z' },
  ];
  const h = detectSignals(tweets, { now }).hypothesis;

  check('产出综合假设', !!h, JSON.stringify(h?.counts));
  check('锚定在同一天（9/22 当地）', h?.dayNum === DAY_922, `实际 ${h?.day}`);
  check('分明硬软：1 条承诺 + 2 条同日提及', h?.counts.hard === 1 && h?.counts.soft === 2, JSON.stringify(h?.counts));
  check(
    '别日的线索不混入证据链',
    !h?.evidence.some((e) => e.id === 'x1'),
    h?.evidence.map((e) => e.id).join(',')
  );
  check(
    '钟点线索被列出，且标明**未采用**',
    h?.clockHints.length === 2 && h.clockHints.every((c) => c.adopted === false),
    JSON.stringify(h?.clockHints?.map((c) => `${c.word}:${c.adopted}`))
  );
  // 这是「宁可不精确，也不造假」的落点：软线索有更细的钟点，
  // 但它们的语境与额度无关，**不能**拿来提升窗口精度。
  check('软证据不提升窗口精度（仍是全天）', h?.precision === 'day', `实际 ${h?.precision}`);
  check(
    '窗口始终是硬证据的产物',
    h?.window?.from === '2026-09-22T07:00:00.000Z',
    `实际 ${h?.window?.from}`
  );
}

{
  // 聚合真正带来精度的地方：同一天有两条承诺，一条到「天」、一条到「钟点」，
  // 应当收敛到更精确的那条。只取「最近一条」会丢掉这个精度。
  const now = new Date('2026-09-22T04:40:00.000Z').getTime();
  const h = detectSignals(
    [
      { id: 'h1', text: "we'll reset the limits Tuesday", created_at: '2026-09-20T04:00:00.000Z' },
      { id: 'h2', text: "we'll reset the limits at 3am on Tuesday", created_at: '2026-09-21T04:00:00.000Z' },
    ],
    { now }
  ).hypothesis;

  check('同日两条承诺 → 取更精确的那条定窗口', h?.precision === 'instant', `实际 ${h?.precision}`);
  check(
    '窗口收敛到 9/22 当地 03:00',
    h?.window?.from === '2026-09-22T10:00:00.000Z',
    `实际 ${h?.window?.from}`
  );
}

{
  // 反向闸门：只有软线索时**不能**产出假设。
  // 把「他随口提到某个周二」升格成一个重置时间，正是这个产品最不能出的错。
  const now = new Date('2026-09-22T04:40:00.000Z').getTime();
  const sig = detectSignals(
    [{ id: 's1', text: '3am on a tuesday', created_at: '2026-09-21T06:26:00.000Z' }],
    { now }
  );
  check('只有软线索、没有承诺 → 不产出假设', sig.hypothesis === null, JSON.stringify(sig.hypothesis?.counts));
}

{
  // 真实数据的回归：这一轮的真实语料里，09-22 这个周二被
  // 2 条承诺 + 2 条同日提及共同指到，另有 3am / 11pm 两个钟点线索未被采用。
  const tweets = JSON.parse(await readFile(resolve(ROOT, 'data/tweets.json'), 'utf8')).tweets;
  const h = detectSignals(tweets, { now: new Date('2026-09-22T04:40:00.000Z').getTime() }).hypothesis;

  check('真实数据产出假设', !!h, JSON.stringify(h?.counts));
  check('真实数据：硬证据 2 条', h?.counts.hard === 2, JSON.stringify(h?.counts));
  check('真实数据：同日软证据 2 条', h?.counts.soft === 2, JSON.stringify(h?.counts));
  check(
    '真实数据：两个钟点线索都在，且都未采用',
    h?.clockHints.length === 2 && h.clockHints.every((c) => !c.adopted),
    JSON.stringify(h?.clockHints?.map((c) => `${c.word}:${c.adopted}`))
  );
  check(
    '真实数据：3am 与 11pm 都被解析出来了（旧实现里它们整段消失）',
    ['3am', '11pm'].every((w) => h.clockHints.some((c) => c.word === w)),
    h?.clockHints?.map((c) => c.word).join(',')
  );
}

/* ==================== 6. 预告合并（一条预告 + 里面 N 条推文） ==================== */

console.log('\n【6】预告：一个窗口一条，支撑它的推文挂在里面');

{
  // 真实数据的回归 —— 老大的原话「这些信息应该合并成一条预告，
  // 然后是一条预告里面 4 条推文」。09-22 那个窗口他先后说了两次
  // （09-19 回复里铺垫、09-22 原创宣布），另有 2 条同日提及，
  // 页面上必须是**一条预告**挂着这 4 条，而不是三处各说一半。
  const tweets = JSON.parse(await readFile(resolve(ROOT, 'data/tweets.json'), 'utf8')).tweets;
  const sig = detectSignals(tweets, { now: new Date('2026-09-22T04:40:00.000Z').getTime() });

  check('真实数据：2 条 explicit 合并成 1 条预告', sig.forecasts.length === 1, `实际 ${sig.forecasts.length}`);
  const f = sig.forecasts[0];
  check('这一条预告里挂了 4 条推文', f.evidence.length === 4, `实际 ${f.evidence.length}`);
  check(
    '4 条推文的构成：2 条承诺 + 2 条同日提及',
    f.counts.hard === 2 && f.counts.soft === 2,
    JSON.stringify(f.counts)
  );
  check('正文取最新那条（他最后把话说全了）', f.text.includes('I promised a reset'), f.text.slice(0, 40));
  check('同一窗口说了 2 次 → sources 记为 2', f.sources === 2, `实际 ${f.sources}`);
  check(
    '预告的窗口与综合假设一致（都取自硬证据）',
    f.window.fromTs === sig.hypothesis.window.fromTs &&
      f.window.toTs === sig.hypothesis.window.toTs,
    `${f.window.fromTs} vs ${sig.hypothesis.window.fromTs}`
  );
  check('未采纳的钟点线索跟着这条预告走', f.clockHints.length === 2, `实际 ${f.clockHints.length}`);
  check(
    '证据条目字段完整（渲染层直接吃，不再二次组装）',
    f.evidence.every((e) => e.id && e.createdAt && e.text && e.via && e.weight),
    JSON.stringify(Object.keys(f.evidence[0] ?? {}))
  );
}

{
  // 反向闸门：**不同窗口不能合并**。他先说周四、后改口周二时，
  // 把两个互斥的窗口拍成一条，比不合并更危险 —— 那会给出一个
  // 谁也不认的时间。
  const now = new Date('2026-09-22T04:40:00.000Z').getTime();
  const sig = detectSignals(
    [
      { id: 'tue', text: 'I promised a reset for Tuesday', created_at: '2026-09-22T04:31:00.000Z' },
      { id: 'thu', text: "we'll reset the limits on Thursday", created_at: '2026-09-21T04:00:00.000Z' },
    ],
    { now }
  );

  check('两个不同窗口 → 两条预告', sig.forecasts.length === 2, `实际 ${sig.forecasts.length}`);
  check(
    '各挂各的证据：假设只锚定一个日子，另一条退化为单条',
    sig.forecasts[0].evidence.length === 1 && sig.forecasts[1].evidence.length === 1,
    sig.forecasts.map((f) => f.evidence.length).join(',')
  );
  check(
    '先到期的窗口排前面',
    sig.forecasts[0].window.fromTs < sig.forecasts[1].window.fromTs,
    sig.forecasts.map((f) => f.window.sourceZone).join(' | ')
  );
}

{
  // 没有承诺就没有预告。只有时间线索的推文走 hint 档，不产生 forecasts。
  const now = new Date('2026-09-22T04:40:00.000Z').getTime();
  const sig = detectSignals(
    [{ id: 's1', text: '3am on a tuesday', created_at: '2026-09-21T06:26:00.000Z' }],
    { now }
  );
  check('没有承诺 → 不产生预告', sig.forecasts.length === 0, `实际 ${sig.forecasts.length}`);
  check('但线索照常保留（hint 档兜底）', sig.hints.length >= 1, `实际 ${sig.hints.length}`);
}

/* ==================== 7. 已兑现／已过期的预告不再展示 ==================== */

console.log('\n【7】过期的预告：兑现之后、或窗口走完之后，不再作为「未来预告」出现');

{
  /* 真实场景（2026-09-23）：他 09-20 / 09-21 预告「周二重置」，窗口是北京
   * 09-22 15:00 → 09-23 14:59；而重置在 09-23 02:23 真的发生了（发券型 credit）。
   *
   * 修复前：页面继续挂着「窗口已开启 · 随时可能重置」，倒计时归零定在那里 ——
   * 一条**已经兑现**的预告被展示成「随时会发生」，把读者的判断方向整个带反。
   * 根因是 analyzeTweet 里的「未来窗口」判定只跟**推文自己的发布时刻**比，
   * 是静态的，不会随时间失效（见 signals.mjs 里 staleWindowReason 的注释）。
   */
  const promised = [{ id: 'p1', text: 'I promised a reset for Tuesday.', created_at: '2026-09-21T22:31:00.000Z' }];
  const now = new Date('2026-09-23T01:49:00.000Z').getTime(); // 北京 09-23 09:49
  const fulfilled = new Date('2026-09-22T18:23:37.000Z').getTime(); // 北京 09-23 02:23

  const before = detectSignals(promised, { now });
  const after = detectSignals(promised, { now, lastResetAt: fulfilled });

  check('修复前的状态：预告在场（先把问题本身钉住）', before.forecasts.length === 1, `实际 ${before.forecasts.length}`);
  check('预告兑现后：forecasts 被撤回', after.forecasts.length === 0, `实际 ${after.forecasts.length}`);
  check(
    'signals 与 forecasts 口径一致（explicit 一并清空）',
    after.counts.explicit === 0,
    `实际 ${after.counts.explicit}`
  );
  check(
    '假设链一起撤 —— 不留「没有主语」的证据链',
    after.hypothesis === null,
    after.hypothesis ? `还在（dayNum=${after.hypothesis.dayNum}）` : ''
  );
}

{
  // 窗口走完、但并没有发生新重置（预告落空）—— 同样不该再当「未来预告」挂着
  const promised = [{ id: 'p1', text: 'I promised a reset for Tuesday.', created_at: '2026-09-21T22:31:00.000Z' }];
  const later = new Date('2026-09-25T04:00:00.000Z').getTime();
  const sig = detectSignals(promised, { now: later, lastResetAt: new Date('2026-09-12T00:00:00.000Z').getTime() });
  check('窗口已过去 → 撤回（落空的预告也不该留着）', sig.forecasts.length === 0, `实际 ${sig.forecasts.length}`);
}

{
  /* ⚠ 这两条反向用例比上面几条更重要。
   *
   * 「过期就不展示」极易做过头 —— 判成「一律不展示」，观测台就彻底失去预告能力，
   * 而且那种错误在真实数据上**看不出来**（当前恰好没有未来预告，页面一样是空的）。
   */
  const future = [
    { id: 'q1', text: 'We will reset all usage limits next Tuesday.', created_at: '2026-09-17T17:57:59.000Z' },
  ];
  const now = new Date('2026-09-18T04:00:00.000Z').getTime();

  const a = detectSignals(future, { now });
  const b = detectSignals(future, { now, lastResetAt: new Date('2026-09-12T00:00:00.000Z').getTime() });
  check(
    '预告指向未来 + 期间没有新重置 → 必须保留',
    a.forecasts.length === 1 && b.forecasts.length === 1,
    `不传 ${a.forecasts.length} / 传 ${b.forecasts.length}`
  );

  // 上一次重置发生在窗口**开始之前**，不构成「这次预告兑现了」——
  // 判据是 lastResetAt >= window.from，不能用 `> 0` 之类偷懒
  const c = detectSignals(future, {
    now,
    lastResetAt: new Date('2026-09-16T00:00:00.000Z').getTime(),
  });
  check('重置发生在窗口开始之前 → 不算兑现，仍保留', c.forecasts.length === 1, `实际 ${c.forecasts.length}`);
}

{
  // 调用方漏传 lastResetAt 时，行为必须与改动前一致（只剩「窗口是否已过去」一道判据）
  const promised = [{ id: 'p1', text: 'I promised a reset for Tuesday.', created_at: '2026-09-21T22:31:00.000Z' }];
  const now = new Date('2026-09-23T01:49:00.000Z').getTime();
  const sig = detectSignals(promised, { now });
  check('不传 lastResetAt：不动旧行为（向后兼容）', sig.forecasts.length === 1, `实际 ${sig.forecasts.length}`);
}

{
  // latestEventMs 的口径是「不分 reset / credit」—— 这次兑现的恰恰是发券型，
  // 若沿用 resetFloorMs 那种只认 type==='reset' 的口径，本次修复根本判不出来。
  const recs = [
    { announced_at: '2026-09-12T03:20:00.000Z', type: 'reset' },
    { announced_at: '2026-09-22T18:23:37.000Z', type: 'credit' },
    { announced_at: '2026-08-01T00:00:00.000Z', type: 'reset' },
  ];
  check(
    'latestEventMs 取最近一次，且**含 credit**',
    latestEventMs(recs) === new Date('2026-09-22T18:23:37.000Z').getTime(),
    new Date(latestEventMs(recs)).toISOString()
  );
  check('空记录 / null → 0（调用方据此跳过这道判据）', latestEventMs([]) === 0 && latestEventMs(null) === 0);
}

/* ==== 9. 已兑现预告的降级：事实不能被同一处的未来语气带走（KI-010）==== */

console.log('\n【9】已兑现预告的降级');

{
  // 真实推文（2026-09-12 03:20，补全正文之后才看见末句）：
  // 前半段宣告「刚刚重置过」，末句预告「今晚还会有一次」。
  // 末句会把整条升级成 explicit，接着因为那条预告早已兑现，被
  // 「已兑现的预告不再展示」**整条**剔除 —— 连「重置确实发生过」也一起丢了。
  const FULL =
    'Hi Astra users. A reset and a quick update on quality issues that have been posted around. ' +
    'Working with some of you, we have found and fixed the following issues. ' +
    'Always grateful for this incredible community. And of course, a reset is also landing by midnight today.';
  const NOW = new Date('2026-09-29T12:00:00.000Z').getTime();
  const mixed = { id: 'mixed', text: FULL, created_at: '2026-09-12T03:20:36.000Z' };

  check('分句判据：这条里的「已发生」部分被认出来', hasOccurredPart(mixed) === true);

  const sig = detectSignals([mixed], { now: NOW, lastResetAt: 0 });
  const e = sig.occurred.find((x) => x.id === 'mixed');
  check('事实部分留在 occurred（不被整条丢弃）', Boolean(e));
  check('窗口被清空（留着会被下游继续当预告读）', e?.window === null);
  check('occurredAt 补上（explicit 的分析不产出它）', e?.occurredAt === '2026-09-12T03:20:36.000Z', e?.occurredAt);
  check('留痕 downgradedFrom=explicit', e?.downgradedFrom === 'explicit');
  check('预告那部分确实撤走了', !sig.forecasts.some((x) => x.id === 'mixed'));
  check('页首档位跟着走的是 occurred', sig.level === 'occurred', sig.level);

  // 反例①（**实测踩过的误判**）：纯预告过期后必须整条撤走，不能凭空多出一条事实。
  // 「I promised a reset for Tuesday」一个未来语气词都没有（`RE_FUTURE` 表里没有 "Tuesday"），
  // 逐句跑 `hasOccurredReset` 会让它的名词化弱证据（"a reset"）直接成立 ——
  // 所以判据必须是「逐句跑**完整**判定」。这一条就是那个坑的守卫。
  const fore = {
    id: 'fore',
    text: 'We are almost Tuesday and I promised a reset for Tuesday. See you soon.',
    created_at: '2026-09-12T03:20:36.000Z',
  };
  check('反例①：这条不被认成「有已发生部分」', hasOccurredPart(fore) === false);
  const sig2 = detectSignals([fore], { now: NOW, lastResetAt: 0 });
  check(
    '反例①：预告过期后整条撤走，不降级成 occurred',
    !sig2.occurred.some((x) => x.id === 'fore') && !sig2.hints.some((x) => x.id === 'fore')
  );

  // 反例②：**未过期**的预告不受影响 —— 降级只针对已兑现的那些，不能顺手改档。
  // 判据用「有没有掉进别的通道」而不是 `forecasts`：forecasts 还要过证据链那一关
  //（单条推文凑不出综合假设），拿它当判据会验不到「档位有没有被改」这件事。
  const live1 = { id: 'live1', text: "We'll reset everyone's usage limits next Tuesday.", created_at: '2026-09-28T03:00:00.000Z' };
  const sig3 = detectSignals([live1], { now: NOW, lastResetAt: 0 });
  const elsewhere = sig3.occurred.some((x) => x.id === 'live1') || sig3.hints.some((x) => x.id === 'live1') || sig3.rejected.some((x) => x.id === 'live1');
  check('反例②：未过期的预告不降级、也没被归到别的通道', !elsewhere);
  check('反例②：页首档位仍是 explicit', sig3.level === 'explicit', sig3.level);

  // 反例③：只有时间线索、没有额度语境 → 走 hint，不进这个降级逻辑。
  const hintOnly = { id: 'hint1', text: 'The keynote is next Tuesday and it will be fun for everyone.', created_at: '2026-09-12T03:20:36.000Z' };
  check('反例③：无额度语境的推文不会被认成事实', hasOccurredPart(hintOnly) === false);
}

/* ==== 10. 带窗口的线索也会过期：窗口过去/被兑现后撤回窗口（KI-011）==== */

console.log('\n【10】带窗口的线索：窗口过去或被兑现后，撤回窗口');

{
  /* 真实场景（2026-09-30）：DevDay 那条发布会推文（09-29 17:06Z）带着「today」
   * 这个时间词，额度意图只有 2 分 —— 不够 explicit，于是**带着窗口落进了 hint**
   *（见 signals.mjs 里 `intent >= 3 ? 'explicit' : 'hint'`）。窗口是当地 09-29
   * 全天（北京 09-29 15:00 → 09-30 14:59）。
   *
   * 而渲染层两个端都是 `.find((s) => s.window)` 挑线索，于是 09-30 下午页首仍然写着
   * 「有一条与额度相关的时间线索 / 窗口到北京 2026.09.30（周三）14:59 为止」——
   * 那个窗口 6 小时前就结束了，窗口里还真的落地了一次重置（北京 09-30 03:00）。
   * 读的人看到的是「还在等」，事实是「早就到了」。
   *
   * 修复前：过期判据只挂在 explicit 上，线索档完全没走这道关。
   */
  const hint = {
    id: 'h1',
    text: 'Usage limits and credits are getting a nice refresh later today.',
    created_at: '2026-09-29T17:06:34.000Z',
  };
  const during = new Date('2026-09-30T02:00:00.000Z').getTime(); // 窗口内（北京 09-30 10:00）
  const after = new Date('2026-09-30T13:18:00.000Z').getTime(); // 窗口已结束（北京 09-30 21:18）

  // 先把「这条样本确实是那个形态」钉住 —— 少了这一步，下面几条断言可能因为
  // 样本根本没落在 hint 档而侥幸变绿（恒绿断言比没有断言更糟）。
  const base = detectSignals([hint], { now: during });
  const h0 = base.hints.find((x) => x.id === 'h1');
  check(
    '样本形态：intent=2 的推文带着窗口落在 hint 档',
    h0?.level === 'hint' && !!h0?.window,
    `level=${h0?.level} window=${!!h0?.window}`
  );
  check('窗口进行中：页首挑得到这条线索（对照）', base.hints.find((s) => s.window)?.id === 'h1');

  const sig = detectSignals([hint], { now: after });
  const h = sig.hints.find((x) => x.id === 'h1');
  check('窗口过去后：窗口被撤回', h?.window === null, JSON.stringify(h?.window));
  check('撤回原因留痕（past）', h?.windowExpired?.why === 'past', JSON.stringify(h?.windowExpired));
  check(
    '撤走的窗口留着原值，可事后复核',
    h?.windowExpired?.from === '2026-09-29T17:06:34.000Z' && h?.windowExpired?.to === '2026-09-30T06:59:00.000Z',
    JSON.stringify(h?.windowExpired)
  );
  check(
    '撤回理由落进判定依据（不只改字段）',
    (h?.reasons ?? []).some((r) => String(r).includes('窗口已过去')),
    JSON.stringify(h?.reasons)
  );
  check(
    '推文本身不丢（线索仍留档，不静默删数据）',
    Boolean(h) && sig.counts.hint === base.counts.hint,
    `hint=${sig.counts.hint}/${base.counts.hint}`
  );
  check('页首不再有可展示的线索窗口', !sig.hints.some((s) => s.window));

  // 直接断言**用户看到的东西**。只断言数据层字段会漏掉「渲染层根本没用这个字段」
  // 这类错误 —— 而这次的 bug 症状恰恰在渲染层。
  const html = renderSignal(sig);
  check('渲染层退回空态：不再出现窗口块（sig-win）', !html.includes('sig-win'), html.slice(0, 140));
  check('渲染层给出空态文案（不是空白）', html.includes('没有检测到重置预告'));
  check('对照：窗口进行中时渲染层**有**窗口块', renderSignal(base).includes('sig-win'));

  /* 反例①：窗口还在未来、期间也没发生重置 → 必须保留。
   * 「过期就撤」极易做过头成「一律不展示」，那种错误在真实数据上**看不出来**
   *（当前恰好没有未来线索，页面一样是空的），只能靠这条用例守着。 */
  const midWindow = new Date('2026-09-29T18:00:00.000Z').getTime();
  const keep = detectSignals([hint], {
    now: midWindow,
    lastResetAt: new Date('2026-09-22T18:23:37.000Z').getTime(), // 窗口开始之前的一次重置
  });
  check('反例①：窗口在未来 + 期间无重置 → 窗口保留', !!keep.hints.find((x) => x.id === 'h1')?.window);

  /* 反例②：窗口**还没走完**，但窗口开始之后已经发生过重置 → 同样是「线索兑现了」，
   * 判据是 lastResetAt >= window.from，不是「窗口是否过去」。 */
  const fulfilled = detectSignals([hint], {
    now: during,
    lastResetAt: new Date('2026-09-29T19:00:00.000Z').getTime(), // 窗口开始之后
  });
  const fh = fulfilled.hints.find((x) => x.id === 'h1');
  check('反例②：窗口内已发生重置 → 窗口撤回', fh?.window === null);
  check('反例②：原因记为 fulfilled（与 past 区分）', fh?.windowExpired?.why === 'fulfilled', JSON.stringify(fh?.windowExpired));
}

{
  /* 反例③：**explicit 的处置不能被顺手改掉**。它是承诺，过期后要么整条撤走、
   * 要么降级成 occurred；绝不能变成一条「没有窗口的线索」赖在页首。 */
  const stale = { id: 'e1', text: "We'll reset everyone's usage limits next Tuesday.", created_at: '2026-09-17T17:57:59.000Z' };
  const now = new Date('2026-09-30T13:18:00.000Z').getTime();
  const sig = detectSignals([stale], { now, lastResetAt: new Date('2026-09-29T19:00:00.000Z').getTime() });
  check('反例③：过期 explicit 没有变成「无窗口线索」', !sig.hints.some((x) => x.id === 'e1'));
  check('反例③：它也没被算进 explicit', !sig.signals.some((x) => x.id === 'e1'));
}

{
  // 真实语料回归：修完之后，「页首要展示的那条线索」不可能是一个已经过去的窗口。
  // 这是这个 bug 的**充分判据** —— 不管将来是哪种推文带窗口，这条都成立。
  const tweets = JSON.parse(await readFile(resolve(ROOT, 'data/tweets.json'), 'utf8')).tweets;
  const records = JSON.parse(await readFile(resolve(ROOT, 'data/resets.json'), 'utf8')).records;
  const NOW = new Date('2026-09-30T13:18:00.000Z').getTime();
  const sig = detectSignals(tweets, { now: NOW, lastResetAt: latestEventMs(records) });

  const stale = sig.hints.filter((s) => s.window && Date.parse(s.window.to) < NOW);
  check('真实语料：没有「窗口已过去却还留着 window」的线索', stale.length === 0, stale.map((s) => s.id).join(','));

  const picked = sig.hints.find((s) => s.window);
  check(
    '真实语料：页首若挑到线索，它的窗口一定还没过去',
    !picked || Date.parse(picked.window.to) >= NOW,
    picked ? `${picked.id} → ${picked.window.to}` : '（本轮没有可展示的线索）'
  );

  // 本次事故的那条推文：窗口必须已被撤回（若它还在窗内，说明判据退化了）
  const culprit = sig.hints.find((s) => s.id === '2104981170685616361');
  check('真实语料：本次事故那条推文的窗口已撤回', !culprit || culprit.window === null, culprit ? JSON.stringify(culprit.window) : '（已不在留档范围内）');
  check(
    '真实语料：渲染层不再出现窗口块',
    !renderSignal(sig).includes('sig-win'),
    renderSignal(sig).slice(0, 140)
  );
}

/* ============ 11. 「一个 s」与「一个参数」：两处静默丢失 ============ */

console.log('\n【11】完成句式的单复数 + lastResetAt 不可省');

{
  /* 判据一：同义的公告，单复数不同必须同判。
   * 他的公告主语是「Reset(s)」这个事件名词，单复数全看他当天怎么写 ——
   * 「Reset all propagated」一直判对，「Resets all propagated」被漏掉。 */
  const singles = [
    ['Reset all propagated. Sweet dreams.', '单数'],
    ['Resets all propagated. That will be all.', '复数'],
  ];
  for (const [text, label] of singles) {
    const a = run(text, '2026-09-27T02:17:54.000Z');
    check(`${label}：判为 occurred`, a.level === 'occurred', `${text} → ${a.level}`);
  }

  /* 判据二：收紧将来完成时之后，真·将来仍要被拦。
   * RE_FUTURE_PERFECT 原本的尾巴 `(?:have|be)` **后面不要求任何词**，
   * 于是「That will be all」这种收尾寒暄也能否决一整条已完成句。 */
  const futureCases = [
    ['We will have reset everyone by tomorrow morning.', '将来完成时'],
    ['The usage limits will be reset tomorrow.', '被动将来'],
    ['The limits will be all reset by tomorrow.', '副词夹在中间的将来完成时'],
    ["We'll reset everyone's limits next Tuesday.", '真预告'],
    ['That will be all.', '纯寒暄（无 reset 词，走早退）'],
    ['Everything will be all good.', '寒暄 + all，但无 reset 词'],
  ];
  for (const [text, label] of futureCases) {
    const a = run(text, '2026-09-27T02:17:54.000Z');
    check(`${label}：不被当成已完成`, a.level !== 'occurred', `${text} → ${a.level}`);
  }
}

{
  /* 判据三：真实语料里，形如「Resets all propagated」的推文必须落进 occurred。
   * 这条是**形状级**的：不管将来他换哪种措辞，只要命中完成句式就不该被丢掉。 */
  const tweets = JSON.parse(await readFile(resolve(ROOT, 'data/tweets.json'), 'utf8')).tweets;
  const records = JSON.parse(await readFile(resolve(ROOT, 'data/resets.json'), 'utf8')).records;
  /* ⚠ NOW 必须锚在**数据自己的时间轴**上，不能写死一个日历日。
   *
   * `windowTo` 就是 NOW，而语料每采一轮就往前长。一旦有新推文越过写死的 NOW，
   * 它就落在窗外，任何桶里都不会出现 —— 这条形状级断言于是自己变红，
   * 报错却只列推文内容，看不出「是夹具过期，不是识别坏了」。
   * 实测（2026-10-07）：NOW 停在 09-30，而 10-02 那条 `Reset all propagated` 已入库，
   * 本断言在 HEAD 上就是红的 —— 与当次改动无关。
   *
   * 取「最新一条推文之后 1 分钟」：窗内有全部历史，且不依赖跑测试的日期。
   * 过滤 `Number.isFinite` 是必须的 —— 缺 `created_at` 的条目会让 Math.max 静默变 NaN。
   */
  const stamps = tweets.map((t) => Date.parse(t.created_at)).filter(Number.isFinite);
  const NOW = Math.max(...stamps) + 60_000;
  const sig = detectSignals(tweets, { now: NOW, lastResetAt: latestEventMs(records) });

  const doneShape = tweets.filter((t) => /\bresets?\s+(?:all\s+)?(?:propagated|complete[ds]?|done|rolled|finished)\b/i.test(t.text || ''));
  check(
    '真实语料：完成句式的推文都判为 occurred',
    doneShape.every((t) => (sig.occurred || []).some((x) => x.id === t.id)),
    doneShape.map((t) => `${t.id}:${t.text.slice(0, 34)}`).join(' | ')
  );

  const culprit = sig.occurred.find((x) => x.id === '2103911959544610829');
  check('真实语料：09-27 那条复数公告已在 occurred 里', Boolean(culprit), `occurred=${(sig.occurred || []).length} 条`);
  check(
    '真实语料：它不在 explicit 里（这才是「一个 s」的后果）',
    !(sig.signals || []).some((x) => x.id === '2103911959544610829')
  );
}

{
  /* 判据四：`detectSignals` 的调用点不许漏传 `lastResetAt`。
   *
   * 为什么用**文本扫描**而不是行为断言：这是「参数漏传」类缺陷，行为断言只能守住
   * 你已经知道要测的那一条路径，漏传的那个新调用点照样恒绿。实测过一次 ——
   * `scripts/preview-miniprogram.mjs` 漏了它，于是 fulfilled 判据永不触发，
   * 本地预览把「已兑现的预告」显示成仍然有效的预告（页面写着 9.28 起，而那一刻
   * 快照里 explicit=0 / forecasts=0）。它的定位恰恰是「上传前发现问题」，
   * 显示的却是别的状态 —— 这种坏法只有扫描调用点才拦得住。
   *
   * 豁免的是**测试文件**（按 `test-` 前缀判定）：它们的产物不面向用户，
   * 且常用空输入或缺省参数来构造场景，本身不构成「显示错状态」。
   * 生产与展示路径一律不在豁免内 —— 包括 `make-prototype.mjs` 这类
   * 「生成给人看的页面」的脚本（它当时也漏了，是同一条扫描查出来的）。 */
  const isTestFile = (rel) => /\/test-[^/]*\.mjs$/.test(rel);
  const callSites = [];
  for (const dir of ['src/lib', 'scripts', 'server']) {
    let files = [];
    try {
      files = await readdir(resolve(ROOT, dir));
    } catch {
      continue; // 目录不存在就跳过，不让断言因此恒红
    }
    for (const f of files) {
      if (!f.endsWith('.mjs')) continue;
      if (f.startsWith('.')) continue; // 临时/隐藏文件不算（例如本地对照用的拷贝）
      const rel = `${dir}/${f}`;
      if (isTestFile(rel)) continue;
      const lines = (await readFile(resolve(ROOT, rel), 'utf8')).split('\n');
      lines.forEach((ln, i) => {
        if (!/\bdetectSignals\s*\(/.test(ln)) return;
        if (/function|export\s|\bimport\b/.test(ln)) return; // 定义行与 import 行不算调用
        const chunk = lines.slice(i, i + 8).join('\n');
        callSites.push({ rel, line: i + 1, ok: /lastResetAt/.test(chunk) });
      });
    }
  }
  // 先守住扫描本身：一个调用点都没扫到的话，下面那条等于恒真
  check('扫描到了 detectSignals 的调用点（≥3 处）', callSites.length >= 3, `扫到 ${callSites.length} 处`);
  const missing = callSites.filter((c) => !c.ok);
  check(
    '每个调用点都传了 lastResetAt（漏一个 = 静默错状态）',
    missing.length === 0,
    missing.map((c) => `${c.rel}:${c.line}`).join(', ') || callSites.map((c) => `${c.rel}:${c.line}`).join(' ')
  );

  /* 判据五：这个参数不是装饰 —— 不传确实会得出**不同**的状态。
   * 否则上面那条守卫会退化成「形式主义」（参数传了但没用）。 */
  const tweets = JSON.parse(await readFile(resolve(ROOT, 'data/tweets.json'), 'utf8')).tweets;
  const records = JSON.parse(await readFile(resolve(ROOT, 'data/resets.json'), 'utf8')).records;
  const NOW = new Date('2026-09-30T15:00:00.000Z').getTime();
  const without = detectSignals(tweets, { now: NOW, account: 'thsottiaux' });
  const withIt = detectSignals(tweets, { now: NOW, account: 'thsottiaux', lastResetAt: latestEventMs(records) });
  check(
    '传/不传 lastResetAt 会得出不同的 level（不传 → 把已兑现的预告当预告）',
    without.level !== withIt.level,
    `不传=${without.level}(forecasts=${(without.forecasts || []).length}) / 传=${withIt.level}(forecasts=${(withIt.forecasts || []).length})`
  );
}

/* ==================== 12. 每日重置窗口（跨多日的持续规则） ==================== */

console.log('\n【12】每日重置窗口');

{
  /* 判定是**三条同时成立**才算（天数 + 二选一 + reset）。
   * 少一条就会把别的话吞进来：只认「28 days」的话，任何提到天数的话都成立。 */
  const hit = [
    [
      'Over the next 28 days, each day we’ll either ship one thing that is a clear improvement or ship a full reset.',
      28,
      '真实公告（10-04）',
    ],
  ];
  for (const [text, days, label] of hit) {
    const r = detectProgram(text);
    check(`${label} 命中且天数=${days}`, r?.days === days, JSON.stringify(r));
  }
  const miss = [
    ['we will ship a reset in the next 30 days', '单次承诺（没有二选一）'],
    ['Over the next 14 days we will ship lots of improvements', '有二选一的味道但没有 reset'],
    ['Four updates or a reset. Or both. How was day 2.', '没有天数'],
    ['Over the next 500 days we’ll either ship a fix or ship a full reset', '天数荒谬（不是窗口）'],
  ];
  for (const [text, label] of miss) {
    check(`${label} → 不命中`, detectProgram(text) === null, JSON.stringify(detectProgram(text)));
  }
}

{
  /* 真实语料：起止、剩余天数、窗口文案都要对得上。
   *
   * 10-04 20:33Z 发的（当地 10-04 13:33），28 天 → 当地 10-04 ~ 10-31。 */
  const tweets = JSON.parse(await readFile(resolve(ROOT, 'data/tweets.json'), 'utf8')).tweets;
  const records = JSON.parse(await readFile(resolve(ROOT, 'data/resets.json'), 'utf8')).records;
  const stamps = tweets.map((t) => Date.parse(t.created_at)).filter(Number.isFinite);
  const NOW = Math.max(...stamps) + 60_000;
  const sig = detectSignals(tweets, { now: NOW, lastResetAt: latestEventMs(records) });
  const p = sig.program;

  check('真实语料：识别出每日窗口', Boolean(p), JSON.stringify(p?.days));
  check('真实语料：天数 28', p?.days === 28, String(p?.days));
  check('真实语料：当地是日期区间（不展开钟点）', p?.window?.sourceZone === '2026.10.04（周日） – 2026.10.31（周六）', p?.window?.sourceZone);
  check(
    '真实语料：北京给「起」而非区间（与「全天」同一处置）',
    p?.window?.userZone === '2026.10.04（周日）15:00 起',
    p?.window?.userZone
  );
  check('真实语料：截止时刻退到 rangeNote', p?.window?.rangeNote === '窗口到北京 2026.11.01（周日）14:59 为止', p?.window?.rangeNote);
  /* 宣布时刻的双时区表述由**数据层**算好（`buildProgram`）。两端各算一次正是本项目
   * 反复吃过亏的地方（词表分裂、时间戳口径不一致），而端上自己算还依赖 Intl ——
   * 部分安卓机型不可用。所以这里钉的是数据层产出的**原文**，不是渲染层的拼装。 */
  check(
    '真实语料：宣布时刻带双时区（北京 + 当地）',
    p?.createdZones?.a?.text === '2026.10.05（周一）04:33' && p?.createdZones?.b?.text === '2026.10.04（周日）13:33',
    JSON.stringify(p?.createdZones && { a: p.createdZones.a?.text, b: p.createdZones.b?.text })
  );
  const today = detectSignals(tweets, { now: NOW, lastResetAt: latestEventMs(records) }).program.daysLeft;
  check('真实语料：剩余天数是 1..28 的整数', Number.isInteger(today) && today >= 1 && today <= 28, String(today));

  /* 逐字节级回归：窗口块的文案里**不许出现任何一个钟点**。
   * 天粒度写成「00:00 – 23:59」正是这一区反复否掉的那种凭空精度 ——
   * 他没说过任何一个钟点，那对端点只是整段的两头。 */
  check(
    '当地那行不带任何钟点',
    !/\d{2}:\d{2}/.test(p?.window?.sourceZone ?? ''),
    p?.window?.sourceZone
  );
}

{
  /* 过期即撤：整段走完（`to < now`）就不再出现 —— 与「过期的预告不再展示」同一条原则。
   * 一条已经结束的承诺留在页面上，只会让读者以为它还在生效。 */
  const old = [
    {
      id: 'old1',
      account: 'thsottiaux',
      text:
        'Over the next 28 days, each day we’ll either ship one thing that is a clear improvement or ship a full reset.',
      created_at: '2026-08-01T20:00:00.000Z',
    },
  ];
  const NOW = Date.parse('2026-09-30T15:00:00.000Z');
  const sig = detectSignals(old, { now: NOW });
  check('窗口走完后不再出现', sig.program === null, JSON.stringify(sig.program));
  check('它确实被扫到了（不是被时间窗挡掉）', sig.checkedTweets === 1, String(sig.checkedTweets));
}

{
  /* 渲染层：弱样式一块，窗口块复用现有渲染器，且**只出现一次**。
   * 「一处只讲一件事」—— 同一份事实铺两块，读者会以为有两个窗口。 */
  const w = {
    sourceZone: '2026.10.04（周日） – 2026.10.31（周六）',
    userZone: '2026.10.04（周日）15:00 起',
    openText: '2026.10.04（周日）15:00',
    rangeNote: '窗口到北京 2026.11.01（周日）14:59 为止',
    fromTs: 1759585200000,
    zones: { a: { offset: 'UTC+8' }, b: { offset: 'UTC-7' }, diffText: '北京时间比 Tibo 当地时间快 15 小时' },
  };
  const base = {
    level: 'none',
    generatedAt: '2026-10-07T01:26:46.566Z',
    checkedTweets: 293,
    windowFrom: '2026-08-08T01:26:46.566Z',
    forecasts: [],
    hints: [],
    rejected: [],
    counts: { hint: 0, rejected: 0 },
  };
  const withProg = renderSignal({
    ...base,
    program: {
      days: 28,
      daysLeft: 26,
      url: 'https://x.com/thsottiaux/status/1',
      announcedAt: '2026-10-04T20:33:43.000Z',
      createdZones: { a: { text: '2026.10.05（周一）04:33' }, b: { text: '2026.10.04（周日）13:33' } },
      window: w,
    },
  });
  check('渲染层出现每日窗口块', withProg.includes('sig-prog'), withProg.slice(0, 60));
  check('窗口块里两个时区都在', withProg.includes('Tibo 当地时间') && withProg.includes('北京时间'));
  check('给出剩余天数', withProg.includes('还剩') && withProg.includes('26'), '');
  check('带原文链接', withProg.includes('https://x.com/thsottiaux/status/1'));
  /* 宣布时刻也要**双时区**。整块里「当地时间」出现在窗口块，所以不能只断言
   * 「含『当地』」—— 那是恒绿。这里钉死完整串，少一侧立刻红。 */
  check(
    '宣布时刻双时区（不是只给北京）',
    withProg.includes('发布于 2026.10.05（周一）04:33 北京 · 2026.10.04（周日）13:33 当地'),
    (withProg.match(/发布于[^<]*/) ?? ['(没渲染出「发布于」)'])[0]
  );
  check('同一份事实只出现一块', withProg.split('sig-prog').length - 1 === 1, String(withProg.split('sig-prog').length - 1));

  // 与预告并存时也只出现一块（program 不该被 forecast 分支再渲染一次）
  const both = renderSignal({
    ...base,
    program: { days: 28, daysLeft: 26, url: '', announcedAt: '2026-10-04T20:33:43.000Z', window: w },
    forecasts: [{ level: 'explicit', window: w, evidence: [], counts: { hard: 1, soft: 0 }, reasons: [] }],
  });
  check('与预告并存时仍只有一块', both.split('sig-prog').length - 1 === 1, String(both.split('sig-prog').length - 1));

  // 反例：没有这个字段时渲染结果里不该有余影（页面与从前逐字节一致）
  const none = renderSignal({ ...base });
  check('没有该字段时不渲染窗口块', !none.includes('sig-prog'), none.slice(0, 60));
}

/* ================================ 结果 ================================ */

console.log(`\n${'─'.repeat(56)}`);
if (fails.length) {
  console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部通过（${pass} 项）`);
