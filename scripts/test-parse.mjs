#!/usr/bin/env node
/**
 * 推文解析的回归校验。
 *
 * 守的是一类**错位**：x.com 的 RSC payload 里 created_at_ms 不只出现在推文上 ——
 * 用户对象（UserCore）也带一个，那是账号注册时间。旧实现把「所有 full_text」
 * 和「所有 created_at_ms」各抓成一个数组再**按索引硬配**，多出来的那一个会把整条链
 * 推歪一位：实测 7 条推文配到 8 个时间戳，第一条推文的时间被写成账号注册日 ——
 * 「2026 is the year of linux desktop」实际发于 2026-09-19，页面上却是 2025-08-07。
 *
 * 这类错位不报错、不崩溃、不产生任何日志，只会让页面上的数字悄悄错掉，
 * 而本发明最核心的那个数字（距上次额度重置多少天）正是从推文时间算出来的。
 * 所以必须有测试守着。
 *
 * 校验的是「按对象就近配对」这个契约，不是某一份具体样本。
 */

import { parseTweets } from '../src/lib/collect.mjs';

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

/* ======================== 结果 ======================== */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
