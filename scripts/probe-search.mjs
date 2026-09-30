#!/usr/bin/env node
/**
 * 只读探针：**用 X 的搜索页**看某个账号在某段时间里发过什么。
 *
 * 为什么需要它：采集走的是「profile 时间线 + 回复雷达（盯一批固定账号）」这两条流。
 * 两条流都覆盖不到的地方（他回复了雷达池之外的人、别人的推文里提到重置、
 * 关键词只出现在某个我没在盯的账号那里）从数据侧是看不见的 —— 那时候唯一能
 * 回答「到底有没有这条推文」的办法就是去搜索里捞一次。
 *
 * 典型用法（排查「是不是漏采了」）：
 *   node scripts/probe-search.mjs 'from:thsottiaux (reset OR banked OR credit) since:2026-09-29'
 *   node scripts/probe-search.mjs 'from:thsottiaux card since:2026-09-28'
 *
 * ⚠ 这是**探针**，不是采集通道：不写库、不合并、不做去重判定。结论要靠人看。
 *   X 的搜索本身有回看深度与索引延迟，搜不到 ≠ 不存在（反过来搜到了就是硬证据）。
 *
 * 参数：<query> [maxSteps]
 */

import { collectStreams } from '../src/lib/browser.mjs';

const query = process.argv[2] ?? 'from:thsottiaux (reset OR banked OR credit)';
const maxSteps = Number(process.argv[3] ?? 6);

// collectStreams 拼的是 `https://x.com/${handle}${path}`，搜索页不是 /<handle> 形态，
// 所以把整段 'search?q=...' 当成 handle、path 留空。这是探针常见的用法，不是采集路径。
const handle = `search?q=${encodeURIComponent(query)}&f=live`;

console.log(`搜索：${query}`);
console.log(`入口：https://x.com/${handle}\n`);

const { streams, errors } = await collectStreams({
  handle,
  paths: [''],
  maxSteps,
  settleMs: 1500,
  fetchFullText: false,
});

const stream = streams?.[0];
if (!stream) {
  console.error('没有取到任何结果。errors =', JSON.stringify(errors));
  process.exit(1);
}

const found = stream.tweets ?? [];
console.log(`命中 ${found.length} 条（已登录=${stream.loggedIn}，翻屏 ${stream.steps} 次，停止原因=${stream.stoppedBy}）：\n`);
for (const t of found) {
  console.log(`${t.created_at} | ${t.id} | ${t.inReplyTo ? `回复 @${t.inReplyTo.account} | ` : ''}${String(t.text ?? '').replace(/\s+/g, ' ').slice(0, 200)}`);
}

// ⚠ 实测（2026-09-30）：搜 `from:thsottiaux since:2026-09-30` 也返回 **0 条**，
//   而那一天他明明发了 20+ 条 —— 说明**这条通道当前取不到搜索结果**（不是真的没有）。
//   所以「0 条」绝不能当成「不存在」来读。这里必须显式喊出来，
//   否则下次有人拿它当「库里没有这条」的证据，方向会被彻底带偏。
if (!found.length) {
  console.log('\n⚠ 0 条**不能**读作「不存在」。实测这条通道取不到搜索结果：');
  console.log('  用 `from:thsottiaux since:2026-09-30` 做对照也返回 0，而当天有 20+ 条推文。');
  console.log('  要么搜索页的 DOM 与本探针的解析式不匹配，要么搜索被登录态/风控挡住。');
  console.log('  要下「有没有这条推文」的结论，先修通这条通道，或改用 X 网页端人工确认。');
}
