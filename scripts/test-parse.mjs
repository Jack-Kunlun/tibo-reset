#!/usr/bin/env node
/**
 * 采集链路的纯函数回归。
 *
 * 主体是推文解析，守着一类**错位**：x.com 的 RSC payload 里 created_at_ms 不只出现在
 * 推文上 —— 用户对象（UserCore）也带一个，那是账号注册时间。旧实现把「所有 full_text」
 * 和「所有 created_at_ms」各抓成一个数组再**按索引硬配**，多出来的那一个会把整条链
 * 推歪一位：实测 7 条推文配到 8 个时间戳，第一条推文的时间被写成账号注册日 ——
 * 「2026 is the year of linux desktop」实际发于 2026-09-19，页面上却是 2025-08-07。
 *
 * 这类错位不报错、不崩溃、不产生任何日志，只会让页面上的数字悄悄错掉，
 * 而本发明最核心的那个数字（距上次额度重置多少天）正是从推文时间算出来的。
 * 所以必须有测试守着。校验的是「按对象就近配对」这个契约，不是某一份具体样本。
 *
 * 另外三块同属「采集链路上会静默出错、且不在解析里」的东西，一并放这里：
 *   · normalizeTimelineItems —— id 归属与时间下界切早切晚
 *   · isKnownScreen         —— 增量的停止判据（早停 = 永久漏推文）
 *   · resolveProxy          —— 出口代理的发现规则（判错 = Chrome 静默收 0 条）
 * 它们的共同点是：错了不报错、不崩溃，只是数据悄悄少一块。
 */

import {
  parseTweets,
  parseTweetDetail,
  pickRadarCandidates,
  rankRadarCandidates,
  resetFloorMs,
} from '../src/lib/collect.mjs';
import { normalizeTimelineItems, isKnownScreen } from '../src/lib/browser.mjs';

let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const section = (t) => console.log(`\n【${t}】`);

/* ------------------- 复刻真实 payload 的构造方式 ------------------- */

// 真实页面里推文对象的 key 就是 base64("Tweet:<id>")，这里照搬同一编码，
// 避免 fixture 与真实结构在编码层面就已经分叉。
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/** 用户对象：**故意带一个 created_at_ms**，它就是历史 bug 里的那个干扰项 */
const USER_CORE = (atMs) =>
  `"client:${b64('User:1953337039510003712')}:core":$R[33]={__id:"client:${b64(
    'User:1953337039510003712'
  )}:core",__typename:"UserCore",name:"Tibo",screen_name:"thsottiaux",created_at_ms:${atMs}}`;

/** 一条推文：legacy（带 id）+ details（带 full_text 与 created_at_ms），字段顺序与真实一致 */
function tweet(id, text, atMs, { withTime = true, withLegacy = true } = {}) {
  const k = b64(`Tweet:${id}`);
  const legacy = withLegacy
    ? `"client:${k}:legacy":$R[1]={__id:"client:${k}:legacy",__typename:"LegacyTweet",possibly_sensitive:null,lang:"en"},`
    : '';
  const time = withTime ? `,created_at_ms:${atMs}` : '';
  return (
    `${legacy}` +
    `"client:${k}:details":$R[2]={__id:"client:${k}:details",__typename:"TBirdData",` +
    `display_text_range:$R[3]=[0,9],full_text:"${text}",hashtag_entities:$R[4]={__refs:$R[5]=[]}${time}}`
  );
}

const wrap = (...parts) => `<script nonce="abc">${parts.join(',')}</script>`;

/** 账号注册时间 —— 旧实现里它顶替了第一条推文的时间 */
const SIGNUP_MS = 1754546827899; // 2025-08-07T06:07:07.899Z
const T1_MS = 1789855286000; // 2026-09-19T22:01:26.000Z
const T2_MS = 1789790014000; // 2026-09-19T03:53:34.000Z

/* ======================== 1. 错位本身 ======================== */

section('历史 bug 的精确复现：用户对象的时间戳排在推文之前');

const bugPayload = wrap(USER_CORE(SIGNUP_MS), tweet('2101431497437950458', 'hello world', T1_MS));
const bugTweets = parseTweets(bugPayload);

check('解析出 1 条推文', bugTweets.length === 1, `实际 ${bugTweets.length}`);
check(
  '推文取到的是自己的时间，不是账号注册时间',
  bugTweets[0]?.created_at === '2026-09-19T22:01:26.000Z',
  `实际 ${bugTweets[0]?.created_at}（若为 2025-08-07 即错位复现）`
);
check('推文正文正确', bugTweets[0]?.text === 'hello world', `实际 ${bugTweets[0]?.text}`);
check(
  '推文 id 正确（未被用户对象的 key 顶掉）',
  bugTweets[0]?.id === '2101431497437950458',
  `实际 ${bugTweets[0]?.id}`
);

/* ======================== 2. 多条各自配对 ======================== */

section('多条推文各自配对（顺序与数量都不许串位）');

const multi = wrap(
  USER_CORE(SIGNUP_MS),
  tweet('1000000000000000001', 'first', T1_MS),
  tweet('1000000000000000002', 'second', T2_MS)
);
const multiTweets = parseTweets(multi);

check('解析出 2 条推文', multiTweets.length === 2, `实际 ${multiTweets.length}`);
check(
  '第 1 条时间 = T1',
  multiTweets[0]?.created_at === '2026-09-19T22:01:26.000Z',
  `实际 ${multiTweets[0]?.created_at}`
);
check(
  '第 2 条时间 = T2',
  multiTweets[1]?.created_at === '2026-09-19T03:53:34.000Z',
  `实际 ${multiTweets[1]?.created_at}`
);
check('第 1 条 id 是第 1 条的', multiTweets[0]?.id === '1000000000000000001', `实际 ${multiTweets[0]?.id}`);
check('第 2 条 id 是第 2 条的', multiTweets[1]?.id === '1000000000000000002', `实际 ${multiTweets[1]?.id}`);

/* ======================== 3. 缺字段时不编造 ======================== */

section('缺字段时不编造、不借用别人的值');

const noTime = parseTweets(wrap(USER_CORE(SIGNUP_MS), tweet('1000000000000000003', 'no time', 0, { withTime: false })));
check(
  '推文自身没有 created_at_ms → created_at 为 null（不许借用用户对象的时间）',
  noTime[0]?.created_at === null,
  `实际 ${noTime[0]?.created_at}`
);

// details 的 key 本身就是 base64("Tweet:<id>")，所以即便没有 legacy 对象也认得出 id。
// 这是有意的鲁棒性：真实页面里一条推文的 legacy / details / counts 各有一个 key，
// 谁在前并不保证，多一条能取到 id 的路就少一种「id 变 null」的失败模式。
const noLegacy = parseTweets(wrap(tweet('1000000000000000004', 'no legacy', T1_MS, { withLegacy: false })));
check(
  '没有 legacy 对象时，仍能从 details 的 key 认出 id',
  noLegacy[0]?.id === '1000000000000000004',
  `实际 ${noLegacy[0]?.id}`
);

// 反面：正文之前完全没有 Tweet 类型的 key 时，必须老实认 null，不许随便认一个
const bare = wrap(
  `"anon:details":$R[9]={__id:"anon:details",__typename:"TBirdData",full_text:"bare",created_at_ms:${T1_MS}}`
);
const bareTweets = parseTweets(bare);
check('正文前没有任何 Tweet 类型 key → id 为 null', bareTweets[0]?.id === null, `实际 ${bareTweets[0]?.id}`);

const onlyUser = parseTweets(wrap(USER_CORE(SIGNUP_MS)));
check('只有用户对象、没有推文 → 空数组', onlyUser.length === 0, `实际 ${onlyUser.length}`);

check('空字符串 → 空数组', parseTweets('').length === 0);
check('完全不相干的 HTML → 空数组', parseTweets('<html><body>nope</body></html>').length === 0);

/* ======================== 4. 窗口限制 ======================== */

section('时间戳窗口：太远的 created_at_ms 不许借用');

// 推文正文之后 3000 字符才出现 created_at_ms —— 超出配对窗口，应判为「没有时间」
const farAway = wrap(
  tweet('1000000000000000005', 'far', 0, { withTime: false }),
  `<span>${'x'.repeat(3000)}</span>`,
  `created_at_ms:${T1_MS}`
);
check(
  '超窗口的 created_at_ms 不被借用 → null',
  parseTweets(farAway)[0]?.created_at === null,
  `实际 ${parseTweets(farAway)[0]?.created_at}`
);

/* ======================== 5. 转义还原 ======================== */

section('转义还原');

const esc = parseTweets(wrap(tweet('1000000000000000006', 'line1\\nline2 \\"quoted\\"', T1_MS)));
check(
  '\\n 还原为换行',
  esc[0]?.text === 'line1\nline2 "quoted"',
  `实际 ${JSON.stringify(esc[0]?.text)}`
);

/* ========== 详情页解析：回复雷达赖以工作的那一层 ========== */

section('详情页解析：主推文 + 回复，每条都要配上正确的作者');

// 详情页的 payload 里，一条推文的作者 screen_name 出现在它的 full_text **之前**
// （实测距离 1.9k–3.7k 字符）。配对靠这个物理顺序，不是按索引硬配。
const detail = (items) =>
  wrap(
    ...items.map(
      (it, i) =>
        `"client:${b64(`User:${it.userId}`)}:core":$R[${10 + i}]={__typename:"UserCore",screen_name:"${it.account}"},` +
        `"client:${b64(`Tweet:${it.id}`)}:details":$R[${20 + i}]={__typename:"TBirdData",full_text:"${it.text}",created_at_ms:${it.at}}`
    )
  );

const FOCAL_ID = '2102194594142208076';
const DETAIL_ITEMS = [
  { id: FOCAL_ID, account: 'udiWertheimer', userId: '1', text: 'this is such an incredible mascot', at: 1790000000000 },
  // 主推文在页面上会出现两次（真实现象），必须按 id 去重
  { id: FOCAL_ID, account: 'udiWertheimer', userId: '1', text: 'this is such an incredible mascot', at: 1790000000000 },
  { id: '2102203239072505893', account: 'shinohai2017', userId: '2', text: '@udiWertheimer Well with claude', at: 1790000100000 },
  { id: '2102204348973416938', account: 'SenseWasHere', userId: '3', text: '@udiWertheimer https://t.co/CCooc4YGDP', at: 1790000200000 },
];

{
  const d = parseTweetDetail(detail(DETAIL_ITEMS), FOCAL_ID);
  check('主推文按 id 命中', d.focal?.id === FOCAL_ID, `实际 ${d.focal?.id}`);
  check('主推文重复出现被去重', !d.replies.some((x) => x.id === FOCAL_ID), '');
  check('回复条数正确', d.replies.length === 2, `实际 ${d.replies.length}`);
  check(
    '回复作者就近配对正确',
    d.replies.map((r) => r.account).join(',') === 'shinohai2017,SenseWasHere',
    `实际 ${d.replies.map((r) => r.account).join(',')}`
  );
}

{
  // 雷达的核心契约：能在回复列表里认出目标账号的回复。
  // 认不出「他回过话」，整套雷达就没有意义。
  const html = detail([
    ...DETAIL_ITEMS,
    {
      id: '2102999999999999999',
      account: 'thsottiaux',
      userId: '4',
      text: "OK fine. But it's also still coming in Tuesday",
      at: 1790100000000,
    },
  ]);
  const d = parseTweetDetail(html, FOCAL_ID);
  const mine = d.replies.filter((r) => r.account === 'thsottiaux');
  check('能从回复列表里认出目标账号的回复', mine.length === 1, `实际 ${mine.length}`);
  check(
    '认出那条的正文正确',
    mine[0]?.text === "OK fine. But it's also still coming in Tuesday",
    `实际 ${mine[0]?.text}`
  );
  check('该回复带着自己的 id（可拼出原始链接）', mine[0]?.id === '2102999999999999999', `实际 ${mine[0]?.id}`);
}

{
  // focalId 对不上时不能崩，退化为「第一条当主推文」
  const d = parseTweetDetail(detail(DETAIL_ITEMS), 'no-such-id');
  check('focalId 不存在时退化而不抛错', d.focal?.id === FOCAL_ID, `实际 ${d.focal?.id}`);
  check('空页面不抛错', parseTweetDetail('<html></html>').focal === null, '');
}

section('雷达候选筛选：只把可能引来回复的推文送进详情页');

{
  const list = [
    { id: '1', text: 'you owe us a banked reset' },
    { id: '2', text: 'this is such an incredible mascot' },
    { id: '3', text: '@thsottiaux any ETA?' },
    { id: '4', text: 'codex picked up my refactor' },
    { id: null, text: 'reset everything right now' },
  ];
  const c = pickRadarCandidates(list);
  check('命中额度词与提及类推文', c.length === 3, `实际 ${c.length}（${c.map((x) => x.id).join(',')}）`);
  check('无 id 的被排除（抓不了详情页）', c.every((x) => x.id), '');
  check('完全无关的推文被排除', !c.some((x) => x.id === '2'), '');
  check('空输入不抛错', pickRadarCandidates(null).length === 0, '');
}

{
  // 雷达实际用的是**排序**不是过滤。
  // 依据：2026-09-21 那次，Tibo 回复的原推文是「你们这周没发布什么有意思的东西」——
  // 额度词出现在同一串推文的下一段里纯属运气。若只写那一句，过滤式闸门会整条丢掉，
  // 而回复里的承诺也就跟着丢了。所以未命中的推文必须留在候选里（只是往后排）。
  const ranked = rankRadarCandidates([
    { id: 'old-plain', text: 'good morning', created_at: '2026-09-18T00:00:00.000Z' },
    { id: 'new-plain', text: 'good evening', created_at: '2026-09-21T00:00:00.000Z' },
    { id: 'quota', text: 'you owe us a banked reset', created_at: '2026-09-17T00:00:00.000Z' },
  ]);
  check('命中的排最前（哪怕它更旧）', ranked[0]?.id === 'quota', `实际 ${ranked[0]?.id}`);
  check('未命中的不被排除，只往后排', ranked.length === 3, `实际 ${ranked.length}`);
  check(
    '未命中的按时间从新到旧',
    ranked[1]?.id === 'new-plain' && ranked[2]?.id === 'old-plain',
    `实际 ${ranked.map((x) => x.id).join(',')}`
  );
  check('无 id 的仍然被排除（抓不了详情页）', rankRadarCandidates([{ id: null, text: 'reset' }]).length === 0, '');
}

/* ============== 登录态时间线：采集下界与结果规范化 ============== */

{
  // 为什么下界要往前留缓冲：2026-09-12 那次，重置确认推文在 08:09Z，
  // 而前序预告「Hi Astra users. A reset and a quick update…」在 03:20Z ——
  // 相隔 5 小时。硬切在 08:09 会把 03:20 那条切掉，而它恰恰是本轮最该被
  // 看见的一条（旧口径只取首屏 7 条，连这两条都没见过）。
  const records = [
    { type: 'reset', announced_at: '2026-09-12T08:09:17.000Z' },
    { type: 'credit', announced_at: '2026-09-14T20:00:00.000Z' }, // 更晚，但不是重置
    { type: 'reset', announced_at: '2026-09-08T01:56:57.501Z' },
  ];
  const floor = resetFloorMs(records);
  check(
    '下界锚在「最近一次 reset」，不是最近一条记录',
    floor === new Date('2026-09-11T08:09:17.000Z').getTime(),
    `实际 ${new Date(floor).toISOString()}`
  );
  check('无重置记录时不做裁剪（返回 0）', resetFloorMs([]) === 0 && resetFloorMs(null) === 0, '');
  check(
    '缓冲小时数可调（0 = 硬切在重置时刻）',
    resetFloorMs(records, 0) === new Date('2026-09-12T08:09:17.000Z').getTime()
  );

  const items = [
    {
      id: '2098685367058612394',
      time: '2026-09-12T08:09:17.000Z',
      text: 'Reset all propagated.',
      url: 'https://x.com/thsottiaux/status/2098685367058612394',
    },
    { id: '2098623000000000000', time: '2026-09-12T03:20:36.000Z', text: 'Hi Astra users.' },
    // 虚拟列表会把同一条重复渲染进 DOM，必须按 id 去重
    { id: '2098685367058612394', time: '2026-09-12T08:09:17.000Z', text: 'Reset all propagated.' },
    { id: '', time: '2026-09-13T00:00:00.000Z', text: '这是转发别人的推文' },
    { id: 'no-time', time: '', text: '缺时间' },
    { id: 'blank-text', time: '2026-09-13T00:00:00.000Z', text: '   ' },
    { id: '2032988000000000000', time: '2026-05-27T15:04:28.000Z', text: '远早于下界的旧推文' },
  ];
  const kept = normalizeTimelineItems(items, { handle: 'thsottiaux', sinceMs: floor });
  check('按 id 去重', kept.length === 2, `实际 ${kept.length}`);
  check(
    '按时间从新到旧',
    kept[0]?.id === '2098685367058612394' && kept[1]?.id === '2098623000000000000',
    kept.map((t) => t.id).join(',')
  );
  check('丢掉没有自己 status 链接的条目（转发）', !kept.some((t) => t.id === ''));
  check('丢掉缺时间 / 正文为空的条目', !kept.some((t) => t.id === 'no-time' || t.id === 'blank-text'));
  check('早于下界的被裁掉', !kept.some((t) => t.id === '2032988000000000000'));
  check('下界是**含**的（边界那条要留下）', kept.some((t) => t.id === '2098623000000000000'));
  check(
    '缺 url 时按 handle 补一条',
    kept[1]?.url === 'https://x.com/thsottiaux/status/2098623000000000000',
    kept[1]?.url
  );
  check('空输入不抛错', normalizeTimelineItems(undefined).length === 0, '');
}

/* ==================== 增量停止判据（「已入库就停」） ==================== */

/*
 * 增量的全部依据就是这一个判断：本屏收下来的条目是否**全部**已入库。
 * 它判错的两种方向代价不对称 —— 早停会永久漏掉新推文（增量不会再回头），
 * 晚停只是多花几秒。所以这里把两个方向都钉住。
 */

{
  const known = new Set(['a', 'b', 'c']);
  const it = (id) => ({ id, time: '2026-09-12T00:00:00.000Z', text: 'x' });

  check('整屏全已知 → 认定已追上', isKnownScreen([it('a'), it('b')], known) === true);
  check(
    '屏里有任何一条新的 → 不认已追上（早停会永久漏掉它）',
    isKnownScreen([it('a'), it('new')], known) === false
  );
  check(
    '取不到 id 的条目（转发别人的推文）不参与判断，也不阻止停',
    isKnownScreen([it('a'), { id: '', text: '转发' }], known) === true
  );
  check(
    '整屏都是取不到 id 的 → 不停（此时没证据说已追上）',
    isKnownScreen([{ id: '', text: '转发' }], known) === false
  );
  check('空屏 → 不停', isKnownScreen([], known) === false);
  check('空输入不抛错', isKnownScreen(undefined, known) === false);
  check('已知集合为空（=全量）时，任何有 id 的屏都不算已追上', isKnownScreen([it('a')], new Set()) === false);
}

/* ==================== 出口代理的发现规则 ==================== */

/*
 * 代理判错的代价是**静默丢数据**：Chrome 拿着一个连不通的代理启动，页面加载不出来，
 * 外层只看到「收割到 0 条推文」。本机就踩过 —— 沙箱把 HTTPS_PROXY 设成自己的
 * 出口端口（连不通 x.com），而真实代理在 7890，且不探测就发现不了。
 */

{
  const { resolveProxy, resetProxyCache } = await import('../src/lib/proxy.mjs');
  const prev = process.env.X_PROXY;

  process.env.X_PROXY = 'off';
  resetProxyCache();
  check('X_PROXY=off → 直连，且不探测', (await resolveProxy()) === null, String(await resolveProxy()));

  process.env.X_PROXY = 'socks5h://127.0.0.1:19999';
  resetProxyCache();
  check(
    'X_PROXY 显式指定即权威（不再探测、不被环境变量覆盖）',
    (await resolveProxy()) === 'socks5h://127.0.0.1:19999',
    String(await resolveProxy())
  );

  if (prev === undefined) delete process.env.X_PROXY;
  else process.env.X_PROXY = prev;
  resetProxyCache();

  check(
    '全部候选不可达 → null（当作直连；境外 runner 正是这种情形）',
    (await resolveProxy({
      candidates: ['http://127.0.0.1:9', 'http://127.0.0.1:8'],
      timeoutMs: 1200,
    })) === null,
    '探测结果不为 null'
  );
  resetProxyCache();
}

/* ======================== 结果 ======================== */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
