#!/usr/bin/env node
/**
 * 详情页全文补全的用例测试（KI-009）。
 *
 * 为什么这个测试必须存在：
 * 长推文在时间线上只渲染前 ~280 字符，"Show more" 之后的节点**不在 DOM 里**，
 * 而收割取的是 `innerText` —— 采到的正文天然只有前半段。症状同样是
 * 「**数据静默缺失**」：不报错、页面照常渲染，只是那半句里没有额度语义，
 * 识别算法读不出来，整条被当无关推文排除。
 *
 * 实测证据（2026-09-29）：09-12 那条重置公告在库里的 278 字符断在
 * 「preventing the model from checking its work.」，而详情页给出的完整正文尾部是
 * 「**And of course, a reset is also landing by midnight today.**」——
 * 「今天午夜前还有一次重置」这半句，原本一个字都没采到。
 *
 * 三组断言对应三处会静默失效的地方：
 *   ① 候选筛选（漏筛 = 该补的没补；重复 = 白花请求）；
 *   ② 合并时**已补全的正文不被更短的采集打回原形**（全量回补每 72 小时重采一次）；
 *   ③ 详情页取正文的判据本身（按 id 认 article、用 `tweetText`、别去碰已证伪的 payload 路）。
 * 另加一组源码级接线断言 —— 纯函数单测全绿而调用点被删，正是 KI-002 的教训。
 *
 * 运行：node scripts/test-fulltext.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pickFullTextCandidates,
  detailProbeExpression,
  harvestExpression,
  TRUNCATED_MIN_LENGTH,
} from '../src/lib/browser.mjs';
import { mergeTweetBatch } from '../src/lib/collect.mjs';

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

/* ========== 1. 候选筛选：该补的别漏、重复的别开两次 ========== */

console.log('\n【1】候选筛选');

{
  const long = 'x'.repeat(TRUNCATED_MIN_LENGTH);
  const short = 'x'.repeat(TRUNCATED_MIN_LENGTH - 1);

  const streams = [
    {
      // 原创流：一条「页面上挂着展开入口但正文很短」+ 一条「够长」+ 一条「又短又没有入口」
      truncatedIds: ['1001'],
      tweets: [
        { id: '1001', text: '短但有展开入口' },
        { id: '1002', text: long },
        { id: '1003', text: short },
      ],
    },
    {
      // 回复流：与原创流重叠 1002（同一批帖子），另有自己收的一条
      truncatedIds: [],
      tweets: [
        { id: '1002', text: long },
        { id: '1004', text: 'y'.repeat(300) },
      ],
    },
  ];

  const r = pickFullTextCandidates(streams, { minLength: TRUNCATED_MIN_LENGTH, max: 12 });
  check('DOM 硬判据命中（短文本也算候选）', r.candidates.includes('1001'));
  check('长度达标进候选', r.candidates.includes('1002'));
  check('又短又没展开入口 → 不进候选', !r.candidates.includes('1003'));
  check('两条流重叠的 id 只出现一次', r.candidates.filter((id) => id === '1002').length === 1);
  check('第二条流自己的长推文也在', r.candidates.includes('1004'));
  check('候选去重后共 3 条（1001 / 1002 / 1004）', r.candidates.length === 3, `实际 ${r.candidates.length}`);
  check('未超上限时 picked 与 candidates 相同', r.picked.length === r.candidates.length && r.skipped === 0);

  const capped = pickFullTextCandidates(streams, { minLength: TRUNCATED_MIN_LENGTH, max: 2 });
  check('超上限时 picked 被截到 max', capped.picked.length === 2, `实际 ${capped.picked.length}`);
  check('截掉的条数如实报出（不静默）', capped.skipped === 1, `实际 ${capped.skipped}`);

  check('空输入不炸', pickFullTextCandidates([], {}).candidates.length === 0);
  check('streams 里混着 null 也不炸', pickFullTextCandidates([null, { tweets: [] }], {}).candidates.length === 0);
  check(
    '没有 id 的条目不进候选',
    pickFullTextCandidates([{ tweets: [{ text: long }] }], { minLength: 10 }).candidates.length === 0
  );
}

/* ========== 2. 合并：补全过的正文不许被更短的采集打回原形 ========== */

console.log('\n【2】合并：text_full 保护');

{
  const NOW = '2026-09-29T12:00:00.000Z';
  const HALF = 'Hi, Tomorrow we are re-opening the Pro $200 subscriptions. Now that';
  const FULL = HALF + ' you have the full picture, half the dollar in API spend, go build.';

  // 库里已经是补全过的全文（全量回补会把它再采一遍，而重采到的又是那半句）
  const base = [
    { id: '2001', text: FULL, text_full: true, created_at: '2026-09-29T06:41:17.000Z', first_seen: '2026-09-29T07:00:00.000Z' },
  ];
  const merged = mergeTweetBatch(
    base,
    [{ id: '2001', text: HALF, created_at: '2026-09-29T06:41:17.000Z', kind: 'other' }],
    NOW
  );
  check('更短的采集不覆盖已补全的正文', merged[0].text === FULL, `实际长度 ${merged[0].text.length}`);
  check('text_full 标记保留', merged[0].text_full === true);
  check('first_seen 保留原值（本地记账，不是推文属性）', merged[0].first_seen === '2026-09-29T07:00:00.000Z');
  check('其余字段照常被新版本更新（kind 跟上了）', merged[0].kind === 'other');

  const longer = mergeTweetBatch(
    base,
    [{ id: '2001', text: `${FULL} 又多了一句。`, created_at: '2026-09-29T06:41:17.000Z' }],
    NOW
  );
  check('更长的采集照常覆盖（补全逻辑升级时靠它推进）', longer[0].text === `${FULL} 又多了一句。`);

  // 未标记 text_full 的条目：更短的照常覆盖 —— 解析器修好后旧错值必须能被纠正
  const plain = [{ id: '2002', text: '旧的时间戳错位版本更长一些', created_at: '2026-09-20T00:00:00.000Z', first_seen: 'x' }];
  const fixed = mergeTweetBatch(plain, [{ id: '2002', text: '改正后的短正文', created_at: '2026-09-20T00:00:00.000Z' }], NOW);
  check('未标 text_full 的条目：更短的照常覆盖（保留纠错能力）', fixed[0].text === '改正后的短正文');

  const added = mergeTweetBatch([], [{ id: '2003', text: '新来的', created_at: '2026-09-28T00:00:00.000Z' }], NOW);
  check('新条目打上 first_seen', added[0].first_seen === NOW);

  const sorted = mergeTweetBatch(
    [{ id: '3001', text: '旧', created_at: '2026-09-01T00:00:00.000Z' }],
    [{ id: '3002', text: '新', created_at: '2026-09-28T00:00:00.000Z' }],
    NOW
  );
  check('结果按时间倒序', sorted[0].id === '3002', `首条 ${sorted[0].id}`);
}

/* ========== 3. 判据：怎么认出「这条被截断了」，怎么在详情页把全文取出来 ========== */

console.log('\n【3】截断判据与详情页取正文的判据');

{
  const harvest = harvestExpression('thsottiaux');
  check('收割表达式去看「展开」入口（DOM 硬判据）', harvest.includes('tweet-text-show-more-link'));
  check('并把结果带出来（truncated:more）', /truncated:\s*more/.test(harvest));
  check('长度门槛留了余量（实测截断点在 275–278，门槛 240）', TRUNCATED_MIN_LENGTH === 240, String(TRUNCATED_MIN_LENGTH));

  const probe = detailProbeExpression('2104823812042940713');
  check('详情页取正文用 tweetText', probe.includes('[data-testid="tweetText"]'));
  // 按 id 认 article，而不是「取第一个」—— 回复里可能引用同一个 id，位置会骗人
  check('按本推文 id 认 article（不靠位置）', probe.includes("'/status/'+ID"));
  check('带上 id 字面量', probe.includes('2104823812042940713'));
  check('输出里带 showMore（详情页若仍有折叠，报告里要看得见）', probe.includes('showMore'));
  // 反向断言：详情页 HTML 里**没有** RSC payload（实测 outerHTML 里 client:/full_text 都不出现），
  // 取它只会白传几 MB。谁要是把这行加回来，这里会红，逼他先看一眼 KI-009 里的实测结论。
  check('不再去捞已证伪的 payload（徒增几 MB 传输）', !probe.includes('outerHTML'));
}

/* ========== 4. 接线：纯函数再对，调用点被删也一样白搭 ========== */

console.log('\n【4】接线（源码级断言）');

{
  const browserSrc = await readFile(resolve(ROOT, 'src/lib/browser.mjs'), 'utf8');
  const collectSrc = await readFile(resolve(ROOT, 'src/lib/collect.mjs'), 'utf8');
  const cliSrc = await readFile(resolve(ROOT, 'scripts/collect.mjs'), 'utf8');

  check('collectStreams 真的会去取全文（不是定义了没人调）', /await collectFullTexts\(/.test(browserSrc));
  check('两条流合并后才判候选（同一条只开一次详情页）', /pickFullTextCandidates\(streams/.test(browserSrc));
  check(
    '详情页逐条单开 target（复用 tab 会取到上一条的正文）',
    /Target\.createTarget/.test(browserSrc) && /Target\.closeTarget/.test(browserSrc)
  );
  check('收割到「展开」标记的 id 会单独送出去（不混进落盘数据）', /truncatedIds:/.test(browserSrc));

  // 顺序断言：正文必须先并进来再 classify。
  // 反了的话会留下「库里是全文、kind 却按半句判的」自相矛盾的记录。
  // ⚠ classify 在源码里出现多次（免登录那条路径也有），必须**从补全那行往后找**，
  // 否则拿到的是另一处的下标，断言看着在跑、其实什么都没验。
  const idxPatch = collectSrc.indexOf('patchTruncatedTexts(\n    [...byId.values()]');
  const idxClassify = collectSrc.indexOf('kind: classify(t.text)', idxPatch);
  check(
    '采集出口：先补全正文、再 classify（顺序不能反）',
    idxPatch > 0 && idxClassify > idxPatch,
    `patch@${idxPatch} classify@${idxClassify}`
  );
  check('主流程把详情页全文接进执行结果', /detailText = r\.fullTexts/.test(collectSrc));
  check('详情页补全的成败写进 stats 留档（坏了要看得出来）', /fullText: fullTextReport/.test(collectSrc));
  check(
    '已补全的正文有挡板（不然全量回补每 72 小时把全文打回半句）',
    /prev\.text_full === true/.test(collectSrc)
  );
  check('CLI 有开关可以关掉它', /--no-full-text/.test(cliSrc) && /fullText: !argv\.includes\('--no-full-text'\)/.test(cliSrc));
  check('CLI 会把补全结果打出来', /正文补全/.test(cliSrc));
  check(
    '降级路径（免登录首屏）明确报告未执行补全，而不是显示成「无候选」',
    /没有登录态可用于详情页/.test(cliSrc)
  );
}

/* ------------------------------- 收尾 ------------------------------- */

console.log('\n' + '─'.repeat(56));
if (fails.length) {
  console.log(`✗ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`);
  for (const f of fails) console.log('  · ' + f);
  process.exitCode = 1;
} else {
  console.log(`✓ 全部通过（${pass} 项）`);
}
