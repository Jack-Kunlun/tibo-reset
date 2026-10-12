#!/usr/bin/env node
/**
 * 历史刷新 + 正文回填的用例测试。
 *
 * 为什么这个测试必须存在：
 * 这两个 bug 的症状都是「**数据静默缺失**」，不报错、不抛异常、页面照常渲染，
 * 只是数字停在一个过时的值上。2026-09-22 那次 banked reset 就是这样丢的 ——
 * 用户看到重置卡已经发下来了，观测台还说「距上次重置 10 天」。
 *
 * 两个根因各自独立，所以两组断言都要有：
 *   ① 历史只在 bootstrap / 空库时回填 → records 冻结，上游新增永远进不来；
 *   ② 长推文正文被 X 页面截断到 ~280 字符 → 额度语义在被切掉的后半段里，
 *      词表再全也读不出来，整条被当无关推文排除。
 *
 * 运行：node scripts/test-history.mjs
 */

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeHistory, mergeConfirmedResets, runCollection, patchTruncatedTexts, buildStats } from '../src/lib/collect.mjs';
import { detectSignals } from '../src/lib/signals.mjs';
import { detectNewResets } from '../server/subscribe.mjs';

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

/* ============ 1. 合并：上游新增的记录必须能进库（本次的核心修复） ============ */

console.log('\n【1】合并：上游新增的记录必须进库');

{
  // 真实 case（2026-09-22）：上游当天就收录了这条 banked reset，
  // 而本地库在它之前就已有 1 条，旧实现此时**再也不会**去拉上游。
  const local = [
    {
      id: '2098685367058612394',
      announced_at: '2026-09-12T08:09:17.000Z',
      type: 'reset',
      text: 'Reset all propagated. Sweet dreams. https://t.co/VgKVUixoJG',
      url: 'https://x.com/thsottiaux/status/2098685367058612394',
      attribution: 'codex-resets.com',
    },
  ];
  const upstreamNew = {
    id: '2102463847714247142',
    announced_at: '2026-09-22T18:23:37.000Z',
    type: 'credit',
    text: 'GPT-6 Sol and Luna are out. … And one more thing. We are loading a banked reset into all accounts of our Plus, Pro and Business users. Let\u2019s go!',
    url: 'https://x.com/thsottiaux/status/2102463847714247142',
    attribution: 'codex-resets.com',
  };

  const m = mergeHistory(local, [upstreamNew, ...local]);
  check('上游新增的 09-22 记录进了库', m.records.some((r) => r.id === upstreamNew.id), `共 ${m.records.length} 条`);
  check('记为新增 1 条、无更新', m.added === 1 && m.updated === 0, `added=${m.added} updated=${m.updated}`);
  check('倒序排列：最新那条排第一', m.records[0].id === upstreamNew.id, `首条 ${m.records[0]?.id}`);
  check('类型映射保留（banked → credit）', m.records[0].type === 'credit', m.records[0].type);

  // 「距上次重置」是页面的头号数字，合并后必须跟着动
  const before = buildStats(local);
  const after = buildStats(m.records);
  check(
    '合并后 last_at 推进到 09-22（不再停在 09-12）',
    after.last_at === '2026-09-22T18:23:37.000Z',
    after.last_at
  );
  check('总数 1 → 2', before.total === 1 && after.total === 2, `${before.total} → ${after.total}`);
  check('发券型计数跟着涨', after.credit_count === 1, String(after.credit_count));
}

{
  // 无变化时必须是「真的没变化」—— 短路逻辑依赖这个信号，
  // 一旦每轮都报有变化，自动化会每轮多提交一条空历史（历史上「48 条提交/天」的成因）。
  const local = [
    { id: 'a', announced_at: '2026-09-12T08:09:17.000Z', type: 'reset', text: 'x', url: null, attribution: 'codex-resets.com' },
  ];
  const same = mergeHistory(local, [{ ...local[0] }]);
  check('上游与本地完全一致 → added=0 且 updated=0', same.added === 0 && same.updated === 0, JSON.stringify({ a: same.added, u: same.updated }));
}

{
  // 共有的条目以上游为准（他可能编辑过推文、上游可能修正时间）
  const local = [{ id: 'a', announced_at: '2026-09-12T00:00:00.000Z', type: 'reset', text: 'old', url: null, attribution: 'codex-resets.com' }];
  const m = mergeHistory(local, [{ id: 'a', announced_at: '2026-09-12T08:09:17.000Z', type: 'credit', text: 'new', url: 'u', attribution: 'codex-resets.com' }]);
  check('共有条目以上游为准（时间/类型/链接都更新）', m.records[0].announced_at === '2026-09-12T08:09:17.000Z' && m.records[0].type === 'credit' && m.records[0].url === 'u', JSON.stringify(m.records[0]));
  check('且计入 updated', m.updated === 1, String(m.updated));
}

{
  // 反向保护：本地正文更长时**不能**被上游的短版覆盖。
  // 上游偶有摘要化/截断，用短的去覆盖长的会让识别能力无声退步。
  const long = 'GPT-6 Sol and Luna are out. ' + 'x'.repeat(300) + ' We are loading a banked reset.';
  const local = [{ id: 'a', announced_at: '2026-09-22T18:23:37.000Z', type: 'credit', text: long, url: null, attribution: 'codex-resets.com' }];
  const m = mergeHistory(local, [{ id: 'a', announced_at: '2026-09-22T18:23:37.000Z', type: 'credit', text: 'short', url: null, attribution: 'codex-resets.com' }]);
  check('正文取更长的那份（短的不许覆盖长的）', m.records[0].text === long, `${m.records[0].text.length} 字符`);
}

{
  // 脏数据不许进库：没有 id 或时间非法的条目会污染统计（last_at 会变成一个错值）
  const m = mergeHistory([], [
    { announced_at: '2026-09-22T00:00:00.000Z', type: 'reset' },
    { id: 'b', announced_at: 'not-a-date', type: 'reset' },
    { id: 'c', announced_at: '2026-09-01T00:00:00.000Z', type: 'reset', text: 'ok' },
  ]);
  check('缺 id 的条目被跳过', !m.records.some((r) => !r.id), JSON.stringify(m.records.map((r) => r.id)));
  check('时间非法的条目被跳过', !m.records.some((r) => r.id === 'b'), JSON.stringify(m.records.map((r) => r.id)));
  check('合法条目正常进库', m.records.some((r) => r.id === 'c') && m.added === 1, `added=${m.added}`);
}

{
  const m = mergeHistory(undefined, undefined);
  check('空输入不炸（本地库首次为空时的路径）', Array.isArray(m.records) && m.records.length === 0 && m.added === 0, JSON.stringify(m));
}

/* ============ 2. 正文回填：被截断的长推文必须补全 ============ */

console.log('\n【2】正文回填：把被 X 页面截断的后半段补回来');

{
  // 真实 case：本地采到 273 字符（截在 "…new usecases and"），
  // 关键语义「We are loading a banked reset」在**被切掉的后半段**里。
  const truncated =
    'GPT-6 Sol and Luna are out. Not only are they a very significant improvement across the board, ' +
    'but also in writing and general "you know when you try it" quality. We are also permanently reducing ' +
    'the API price by 50% making both of them viable for a ton of new usecases and';
  const full =
    truncated +
    '\n\nmaking your usage go further too, even on the subscriptions.\n\n' +
    'And one more thing. We are loading a banked reset into all accounts of our Plus, Pro and Business users. ' +
    "Let's go!" +
    '\n\nhttps://t.co/00DRh1sRrO';

  const tweets = [{ id: 'X1', text: truncated, created_at: '2026-09-22T18:23:37.000Z' }];
  const r = patchTruncatedTexts(tweets, new Map([['X1', full]]));

  check('截断的正文被补全', r.tweets[0].text.length > truncated.length, `${truncated.length} → ${r.tweets[0].text.length}`);
  check('补全后能读到额度语义（这才是修复的意义）', r.tweets[0].text.includes('banked reset'), r.tweets[0].text.slice(-60));
  check('标记 text_full=true（补全不是偷偷做的）', r.tweets[0].text_full === true, String(r.tweets[0].text_full));
  check('换行已归一化（与推文库口径一致，不混两种格式）', !/\n/.test(r.tweets[0].text), JSON.stringify(r.tweets[0].text.slice(60, 100)));
  check('计数为 1', r.patched === 1, String(r.patched));
  check('原文保留的时间戳不动', r.tweets[0].created_at === '2026-09-22T18:23:37.000Z', r.tweets[0].created_at);
}

{
  // 反向保护：上游更短时不许动，也不许打 text_full 标记（否则「补全」会变成「替换」）
  const tweets = [{ id: 'X2', text: 'a'.repeat(400) + ' banked reset' }];
  const r = patchTruncatedTexts(tweets, new Map([['X2', 'short']]));
  check('上游更短 → 一个字都不动', r.tweets[0].text === tweets[0].text && r.patched === 0, `${r.tweets[0].text.length} 字符`);
  check('且不误打 text_full 标记', r.tweets[0].text_full === undefined, String(r.tweets[0].text_full));
}

{
  const tweets = [{ id: 'X3', text: 'untouched' }, { id: 'X4', text: 'untouched' }];
  const r = patchTruncatedTexts(tweets, new Map([['X9', 'a'.repeat(100)]]));
  check('上游没有的 id → 全部不动', r.patched === 0 && r.tweets.every((t) => t.text === 'untouched'), JSON.stringify(r.patched));
}

{
  // 真实 case 之二：9/12 那条本地采到 35 字符，丢了尾部 t.co 链接（页面把它渲染成卡片）。
  // 补全之后它与 records 里的正文一致 —— 两个库对同一条推文的说法不该不一样。
  const tweets = [{ id: 'Y1', text: 'Reset all propagated. Sweet dreams.' }];
  const r = patchTruncatedTexts(tweets, new Map([['Y1', 'Reset all propagated. Sweet dreams. https://t.co/VgKVUixoJG']]));
  check('9/12 那条补回尾部链接', r.tweets[0].text === 'Reset all propagated. Sweet dreams. https://t.co/VgKVUixoJG', r.tweets[0].text);
}

/* ====== 3. 源码断言：防「纯函数单测全绿、但调用点被删」 ====== */

console.log('\n【3】接线：这两条修复必须真的被主流程调用');

const collectSrc = await readFile(resolve(ROOT, 'src/lib/collect.mjs'), 'utf8');
const codeLines = collectSrc
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
  .join('\n');

{
  // ① 历史刷新不能再被「bootstrap / 空库」守护 —— 那就是本次 bug 的根因
  check(
    '历史刷新不再只在 bootstrap / 空库时执行（根因）',
    !/opts\.bootstrap\s*\|\|\s*history\.records\.length\s*===\s*0/.test(codeLines),
    '仍存在 `opts.bootstrap || history.records.length === 0` 这个条件'
  );
  check('每轮都调用 fetchHistory 刷新历史', /const upstream = await fetchHistory\(\)/.test(collectSrc));
  check('刷新结果经 mergeHistory 合并（而不是整体覆盖）', /mergeHistory\(history\.records,\s*upstream\)/.test(collectSrc));

  // ② 正文回填要真的接在推文库上
  check('正文回填被主流程调用', /patchTruncatedTexts\(live\.tweets/.test(collectSrc));
  check('上游正文映射来自同一批记录（不额外发请求）', /upstreamText\.set\(r\.id,\s*r\.text\)/.test(collectSrc));

  // ③ 短路不能把历史更新一起吞掉 —— 否则「下一轮同样短路」，新记录永远进不了库
  check(
    '短路条件包含 historyChanged（否则历史更新会被静默吞掉）',
    /if \(skippedFresh && !historyChanged && textPatched === 0\)/.test(collectSrc),
    '短路判断没带上 historyChanged / textPatched'
  );

  // ④ 上游失败时的分级：有本地数据就不该把整轮判失败（会在页面贴误导横幅）
  check(
    '上游失败时按「本地有没有数据」分级（已有数据不升级为整轮失败）',
    /if \(history\.records\.length === 0\) errors\.push\(`历史回填失败/.test(collectSrc),
    '缺少分级处理'
  );

  // ⑤ 留档：否则「为什么距上次重置变了」事后答不出来
  check('stats 落盘带 history 留档', /history: \{ \.\.\.historyReport, changed: historyChanged/.test(collectSrc));
  check('没有采集时 collect 状态标 carriedOver（不显示成空来源）', /carriedOver: true/.test(collectSrc));
}

/* ====== 4. 真实数据回归：磁盘上的库必须与「上游已收录」保持同步 ====== */

console.log('\n【4】真实数据回归：本地库与上游正文口径');

{
  const resets = JSON.parse(await readFile(resolve(ROOT, 'data/resets.json'), 'utf8'));
  const tweets = JSON.parse(await readFile(resolve(ROOT, 'data/tweets.json'), 'utf8')).tweets;

  check('records 全都有 id 与合法时间', resets.records.every((r) => r.id && !Number.isNaN(new Date(r.announced_at).getTime())));
  check('records 按时间倒序', resets.records.every((r, i, a) => i === 0 || new Date(a[i - 1].announced_at) >= new Date(r.announced_at)));

  // 同一条推文在两个库里不该有两种正文长度：records 里是上游完整版，
  // 推文库里若更短，说明回填还没跑过（或回填规则失效）。
  const byId = new Map(tweets.map((t) => [t.id, t]));
  const mismatch = resets.records
    .filter((r) => byId.has(r.id))
    .filter((r) => {
      const t = byId.get(r.id);
      const normalized = r.text.replace(/\s+/g, ' ').trim();
      return normalized.length > t.text.length && !t.text_full;
    });
  check(
    '两库正文一致：记录了完整正文的推文，推文库里也已是完整版（或已标 text_full）',
    mismatch.length === 0,
    mismatch.map((r) => `${r.id}: records ${r.text.length} > tweets ${byId.get(r.id).text.length}`).join(', ')
  );
}

console.log('\n【5】第三方未收录时，完成公告直接更新；后续收录不能重复计数');
{
  const account = 'thsottiaux';
  const now = Date.parse('2026-10-11T04:10:00Z');
  const previous = [{ id: '2108040921044639779', announced_at: '2026-10-08T03:44:55.000Z',
    type: 'credit', text: 'Confirmed landed across all accounts.', attribution: 'codex-resets.com' }];
  const confirmed = { id: '2109132167112782291', created_at: '2026-10-11T04:01:09.000Z',
    text: 'Put the reset in the bag. All propagated. https://t.co/HGxaD3Zdcj',
    account, foundVia: 'timeline-browser', author_verified: true };
  const forecast = { id: '2109045392684032299', created_at: '2026-10-10T22:16:20.000Z',
    text: 'Global reset by EOD. May the tokens do good things for you.', account, foundVia: 'timeline-browser', author_verified: true };
  const merged = mergeConfirmedResets(previous, [forecast, confirmed], { now, account });
  check('完成公告直接新增一条，预告不入库', merged.added === 1 && merged.records.length === 2);
  check('最近重置推进到公告发布时刻，不取采集时刻', buildStats(merged.records).last_at === confirmed.created_at);
  check('直接来源可追溯到作者和推文', merged.records[0].attribution === 'x.com/thsottiaux' &&
    merged.records[0].url === `https://x.com/thsottiaux/status/${confirmed.id}`);
  check('入库后 EOD 预告立即撤回', detectSignals([forecast, confirmed], { now,
    lastResetAt: Date.parse(merged.records[0].announced_at) }).forecasts.length === 0);
  check('重跑同一批数据幂等', mergeConfirmedResets(merged.records, [confirmed], { now, account }).added === 0);

  for (const [label, patch] of [
    ['其他作者', { account: 'someone' }], ['无作者', { account: undefined }],
    ['作者未经核验', { author_verified: undefined }],
    ['免登录混合来源', { foundVia: 'timeline' }], ['未知来源', { foundVia: undefined }],
    ['未来时间', { created_at: '2026-10-12T00:00:00Z' }], ['非法时间', { created_at: 'bad' }],
    ['旧公告', { created_at: '2026-10-07T00:00:00Z' }], ['缺少 id', { id: undefined }],
    ['正在发放', { text: "Loading a banked reset in everyone's paid accounts." }],
    ['否定完成', { text: 'The reset has not propagated yet.' }],
    ['未到', { text: 'A reset is coming for everyone.' }],
    ['截断的完成句', { text: 'Therefore ... the reset has been https://t.co/example' }],
    ['疑问', { text: 'Has the reset completed?' }],
    ['个人额度', { text: 'My usage limits have been reset.' }],
    ['单账户完成', { text: 'The reset has propagated for a single account.' }],
    ['部分账户完成', { text: 'The reset has propagated for some accounts.' }],
    ['仅部分套餐', { text: 'The reset has propagated for all Pro accounts only.' }],
    ['Pro 套餐范围', { text: 'The reset has propagated for all Pro accounts.' }],
    ['Team 套餐范围', { text: 'The reset has propagated for all Team accounts.' }],
    ['Enterprise 套餐范围', { text: 'The reset has propagated for all Enterprise accounts.' }],
    ['无领域的完成短句', { text: 'Confirmed landed across all accounts.' }],
    ['历史回顾', { text: 'Yesterday the reset completed.' }],
    ['往年回顾', { text: 'In 2025, the reset has propagated for all accounts.' }],
    ['过去日期回顾', { text: 'On 2025-01-01, the reset has propagated for all accounts.' }],
    ['数字月日回顾', { text: 'On 10/01, the reset has propagated for all accounts.' }],
    ['本月先前回顾', { text: 'Earlier this month, the reset has propagated for all accounts.' }],
    ['月份回顾', { text: 'In September, the reset has propagated for all accounts.' }],
    ['模型权重', { text: 'The model weights have been reset.' }],
  ]) {
    check(`${label}不能直接新增历史`, mergeConfirmedResets(previous, [{ ...confirmed, ...patch }], { now, account }).added === 0);
  }
  const passive = mergeConfirmedResets(previous, [{ ...confirmed, text: "Everyone's limits have been reset." }], { now, account });
  check('全体额度的明确完成句仍能入库', passive.added === 1);
  check('全体付费用户仍按既有产品口径入库', mergeConfirmedResets(previous, [{ ...confirmed,
    text: 'The usage limits have been reset for all paid users of Codex and ChatGPT Work.',
  }], { now, account }).added === 1);
  const alias = { ...merged.records[0], id: `observed-${confirmed.id}`, attribution: 'codex-resets.com',
    url: `https://twitter.com/thsottiaux/status/${confirmed.id}?s=20` };
  const upstream = mergeHistory(merged.records, [alias]);
  check('上游合成 id 按同一来源合并，不能再新增', upstream.added === 0 && upstream.updated === 1 && upstream.records.length === 2);
  check('上游修正保留为权威记录', upstream.records[0].id === alias.id && upstream.records[0].attribution === 'codex-resets.com');
  check('合并后再收同一公告仍不增加', mergeConfirmedResets(upstream.records, [confirmed], { now, account }).added === 0);

  const followup = { ...confirmed, id: '2109132167112782292', created_at: '2026-10-11T04:05:09.000Z',
    text: "Everyone's limits have been reset." };
  const sameBatch = mergeConfirmedResets(previous, [confirmed, followup], { now, account });
  check('同轮不同推文的短期重复确认只新增一次', sameBatch.added === 1 && sameBatch.updated === 1 && sameBatch.records.length === 2);
  const nextBatch = mergeConfirmedResets(merged.records, [followup], { now, account });
  check('跨轮重复确认不加次数，也不推进首次确认时刻', nextBatch.added === 0 && nextBatch.updated === 1 && nextBatch.records[0].announced_at === confirmed.created_at);
  check('重复确认的全部来源留下可合并证据', nextBatch.records[0].confirmation_urls.includes(`https://x.com/thsottiaux/status/${followup.id}`));
  const followupUpstream = mergeHistory(nextBatch.records, [{ ...alias, url: `https://x.com/thsottiaux/status/${followup.id}` }]);
  check('上游收录后续确认也归并到同一次', followupUpstream.added === 0 && followupUpstream.records.length === 2);
  const bothUpstream = [
    { ...alias, id: followup.id, text: followup.text, announced_at: followup.created_at, url: `https://x.com/thsottiaux/status/${followup.id}` },
    { ...alias, id: confirmed.id, url: `https://x.com/thsottiaux/status/${confirmed.id}` },
  ];
  const both = mergeHistory(nextBatch.records, bothUpstream);
  check('上游多次确认只保留一次，首次确认时刻不推进', both.added === 0 && both.records.length === 2 && both.records[0].announced_at === confirmed.created_at);
  check('采用另一条确认时正文与来源一致，不沿用较长的旧帖', both.records[0].text === followup.text);
  const bothAgain = mergeHistory(both.records, bothUpstream);
  check('上游多确认反复合并无变化，不来回换 id', bothAgain.added === 0 && bothAgain.updated === 0);
  check('后续确认被上游收录不能越过已通知水位', detectNewResets(both.records, confirmed.created_at).length === 0);
  check('后续确认反复处理幂等', mergeConfirmedResets(nextBatch.records, [followup], { now, account }).updated === 0);
  check('明确 another reset 可区分短间隔第二次发放', mergeConfirmedResets(merged.records, [
    { ...followup, text: 'Another reset all propagated.' },
  ], { now, account }).added === 1);
  const again = { ...forecast, id: '2109132167112782293', text: 'Another reset by EOD.', created_at: '2026-10-11T04:03:09.000Z' };
  check('发布新预告后短间隔完成仍可作为新事件', mergeConfirmedResets(merged.records, [again, followup], { now, account }).added === 1);
  check('未经核验的预告不能打开短间隔新事件', mergeConfirmedResets(merged.records, [
    { ...again, author_verified: false }, followup,
  ], { now, account }).added === 0);
  check('不同轮的较晚完成公告可新增', mergeConfirmedResets(merged.records, [
    { ...followup, created_at: '2026-10-11T07:05:09.000Z' },
  ], { now: Date.parse('2026-10-11T07:10:00Z'), account }).added === 1);

  const dir = await mkdtemp(resolve(tmpdir(), 'tibo-confirmed-history-'));
  try {
    for (const [name, value] of Object.entries({ resets: { records: previous }, tweets: {
      tweets: [forecast, confirmed], updated_at: new Date(now).toISOString(), source: 'browser',
    }, stats: {} })) await writeFile(resolve(dir, `${name}.json`), JSON.stringify(value));
    const result = await runCollection({ dataDir: dir, skipLive: true, account });
    const stored = JSON.parse(await readFile(resolve(dir, 'resets.json'), 'utf8'));
    const stats = JSON.parse(await readFile(resolve(dir, 'stats.json'), 'utf8'));
    check('主流程把直接公告写入 resets.json', stored.records[0].id === confirmed.id && stored.records.length === 2);
    check('主流程统计同步推进并记录来源数量', stats.stats.last_at === confirmed.created_at && result.history.confirmedAdded === 1);
    check('主流程输出不再挂已兑现预告', result.signals.forecasts.length === 0);
    await runCollection({ dataDir: dir, skipLive: true, account });
    check('连续落盘两轮 records 逐字一致', JSON.stringify(stored.records) ===
      JSON.stringify(JSON.parse(await readFile(resolve(dir, 'resets.json'), 'utf8')).records));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/* ================================ 结果 ================================ */

console.log(`\n${'─'.repeat(56)}`);
if (fails.length) {
  console.log(`✗ 失败 ${fails.length} 项 / 通过 ${pass} 项`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部通过（${pass} 项）`);
