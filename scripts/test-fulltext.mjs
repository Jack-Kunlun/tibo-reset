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
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pickFullTextCandidates,
  detailProbeExpression,
  harvestExpression,
  makeFullTextReport,
  waitForDetailProbe,
  TRUNCATED_MIN_LENGTH,
} from '../src/lib/browser.mjs';
import { confirmedResetEvent } from '../src/lib/signals.mjs';
import { mergeTweetContexts, mergeTweetBatch } from '../src/lib/collect.mjs';

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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceModule(source) {
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

function fakeProbeReader(waitForProbe, responses) {
  let elapsed = 0;
  let calls = 0;
  const result = waitForProbe(
    async () => responses[Math.min(calls++, responses.length - 1)],
    {
      settleMs: 100,
      contextWaitMs: 300,
      maxWaitMs: 1_000,
      now: () => elapsed,
      pause: async (ms) => { elapsed += ms; },
    },
  );
  return { result, get calls() { return calls; } };
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

  const completionTexts = ['Done', "It's done.", 'It is done!', 'Done and dusted.', 'Done https://t.co/example'];
  for (const [index, text] of completionTexts.entries()) {
    check(`严格的落地短句 ${index + 1} 进入详情候选`,
      pickFullTextCandidates([{ tweets: [{ id: `done-${index}`, text }] }]).candidates.includes(`done-${index}`));
  }
  for (const text of ['The API feature is done.', 'Not done yet.', 'Done when rollout finishes.']) {
    check(`功能进度或否定句不进落地候选：${text}`,
      pickFullTextCandidates([{ tweets: [{ id: 'not-reset-done', text }] }]).candidates.length === 0);
  }

  const browserSource = await readFile(resolve(ROOT, 'src/lib/browser.mjs'), 'utf8');
  const before = sha256(browserSource);
  const missingLinkedDoneRule = browserSource.replace(
    '|| isLinkedCompletionText(text) ||',
    '|| false ||',
  );
  assert.notEqual(missingLinkedDoneRule, browserSource, '短完成句候选变异点存在');
  const noLinkedDoneCandidate = await sourceModule(missingLinkedDoneRule);
  check('隔离变异：漏掉裸 Done 候选会被正例断言拦住',
    !noLinkedDoneCandidate.pickFullTextCandidates([{ tweets: [{ id: 'bare-done', text: 'Done' }] }]).candidates.includes('bare-done'));

  const broadLinkedDoneRule = browserSource.replace(
    "return /^(?:it[’']s\\s+|it is\\s+)?done(?:\\s+and\\s+dusted)?[.!]?$/i.test(value);",
    'return /\\bdone\\b/i.test(value);',
  );
  assert.notEqual(broadLinkedDoneRule, browserSource, '宽泛完成句变异点存在');
  const broadDoneCandidate = await sourceModule(broadLinkedDoneRule);
  check('隔离变异：把 feature prose 当完成回复会被负例断言拦住',
    broadDoneCandidate.pickFullTextCandidates([{ tweets: [{ id: 'feature-done', text: 'The API feature is done.' }] }]).candidates.includes('feature-done'));
  check('完成短句候选变异仅在内存中执行', sha256(await readFile(resolve(ROOT, 'src/lib/browser.mjs'), 'utf8')) === before);
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

/* ========== 4. 详情页正文与祖先分批渲染：等待但不猜上下文 ========== */

console.log('\n【4】延迟回复上下文与可见诊断');

{
  const fullText = 'Landing tomorrow before 10am PST together with a small ship.';
  const verifiedParent = {
    id: '2113492187770175603', account: 'thsottiaux',
    text: 'Day 18/ ... that’s a reset!', created_at: '2026-10-23T04:46:19.000Z',
    relation: 'reply', verified: true,
  };
  const delayed = fakeProbeReader(waitForDetailProbe, [
    { dom: fullText },
    { dom: fullText, inReplyTo: verifiedParent },
  ]);
  const delayedResult = await delayed.result;
  check('正文先出现、祖先后出现时继续等到核验关系',
    delayedResult?.inReplyTo?.id === verifiedParent.id && delayedResult.replyContextStatus === 'verified',
    JSON.stringify(delayedResult));
  check('不必等满超时，祖先出现后立即返回', delayed.calls === 2, `读取 ${delayed.calls} 次`);

  const standalone = fakeProbeReader(waitForDetailProbe, [{ dom: fullText }]);
  const standaloneResult = await standalone.result;
  check('短句始终没有父帖时明确报告上下文缺失',
    standaloneResult?.replyContextStatus === 'missing' && standaloneResult.needsReplyContext === true);
  check('没有父帖证据时不合成自回复关系', standaloneResult?.inReplyTo == null);
  const report = makeFullTextReport(2, 2, 0, [
    { id: 'standalone-short', replyContextStatus: standaloneResult.replyContextStatus },
    { id: 'verified-reply', replyContextStatus: 'verified' },
  ]);
  check('fullTextReport 单独列出缺上下文的短句 ID',
    report.missingReplyContext.length === 1 && report.missingReplyContext[0] === 'standalone-short');
  check('有自身重置语义的完整句无需等待父帖',
    (await waitForDetailProbe(async () => ({ dom: 'The reset is landing by midnight today.' }), {
      settleMs: 1, maxWaitMs: 10, pause: async () => {}, now: () => 0,
    }))?.replyContextStatus === 'not-required');

  const doneReply = fakeProbeReader(waitForDetailProbe, [
    { dom: 'Done' },
    { dom: 'Done', inReplyTo: verifiedParent },
  ]);
  check('裸 Done 回复也等待并沿已核验父帖继续',
    (await doneReply.result)?.replyContextStatus === 'verified' && doneReply.calls === 2);
  check('功能进度 Done 不等待重置父帖',
    (await waitForDetailProbe(async () => ({ dom: 'The API feature is done.' }), {
      settleMs: 1, maxWaitMs: 10, pause: async () => {}, now: () => 0,
    }))?.replyContextStatus === 'not-required');

  const browserSource = await readFile(resolve(ROOT, 'src/lib/browser.mjs'), 'utf8');
  const before = sha256(browserSource);
  const waitMutant = browserSource.replace(
    'if (!contextExpected || latest.replyContextStatus === \'verified\') return latest;',
    'if (!contextExpected || latest.replyContextStatus === \'verified\' || contextDeadline === null) return latest;',
  );
  assert.notEqual(waitMutant, browserSource, '延迟祖先变异点存在');
  const brokenWait = await sourceModule(waitMutant);
  const brokenDelayed = fakeProbeReader(brokenWait.waitForDetailProbe, [
    { dom: fullText },
    { dom: fullText, inReplyTo: verifiedParent },
  ]);
  const brokenDelayedResult = await brokenDelayed.result;
  check('隔离变异：正文一出现就提前返回会被延迟祖先断言拦住',
    !(brokenDelayedResult?.inReplyTo?.id === verifiedParent.id && brokenDelayed.calls === 2));

  const diagnosticMutant = browserSource.replace(
    "contextExpected ? 'missing' : 'not-required'",
    "contextExpected ? 'not-required' : 'not-required'",
  );
  assert.notEqual(diagnosticMutant, browserSource, '上下文诊断变异点存在');
  const brokenDiagnostic = await sourceModule(diagnosticMutant);
  const brokenStandalone = fakeProbeReader(brokenDiagnostic.waitForDetailProbe, [{ dom: fullText }]);
  check('隔离变异：吞掉缺失状态会被诊断断言拦住',
    (await brokenStandalone.result)?.replyContextStatus !== 'missing');
  const reportMutant = browserSource.replace(
    "missingReplyContext: scanned.filter((item) => item.replyContextStatus === 'missing').map((item) => item.id),",
    'missingReplyContext: [],',
  );
  assert.notEqual(reportMutant, browserSource, '报告列表变异点存在');
  const brokenReport = await sourceModule(reportMutant);
  check('隔离变异：fullTextReport 不列缺失 ID 会被行为断言拦住',
    brokenReport.makeFullTextReport(1, 1, 0, [{ id: 'standalone-short', replyContextStatus: 'missing' }])
      .missingReplyContext.length === 0);
  check('浏览器源码变异仅在内存中执行', sha256(await readFile(resolve(ROOT, 'src/lib/browser.mjs'), 'utf8')) === before);
}

/* 完成帖可能是这轮唯一新推文，必须补齐缓存父帖到重置主帖的链。 */
{
  const [root, reply] = JSON.parse(await readFile(resolve(ROOT, 'scripts/fixtures/reset-lifecycle-oct23.json'), 'utf8'));
  const id = '2113500000000000000';
  const completion = { ...reply, id, url: `https://x.com/thsottiaux/status/${id}`, text: 'Done.',
    created_at: '2026-10-23T17:00:00Z', inReplyTo: null };
  const known = [root, { ...reply, inReplyTo: null }];
  const ref = (t) => ({ id: t.id, account: t.account, text: t.text, created_at: t.created_at,
    url: t.url, relation: 'reply', verified: true });
  async function replay(source) {
    const executable = await sourceModule(source.replace('async function harvestFullTexts(', 'export async function harvestFullTexts('));
    let current = null;
    const visited = [];
    const cdp = { sessionId: null, send: async (method, params) => {
      if (method === 'Target.createTarget') return { targetId: 'mock' };
      if (method === 'Target.attachToTarget') return { sessionId: 'mock' };
      if (method === 'Page.navigate') { current = params.url.split('/').pop(); visited.push(current); }
      return {};
    }, evalJs: async () => current === id
      ? { dom: completion.text, inReplyTo: ref(reply) }
      : { dom: reply.text, inReplyTo: ref(root) } };
    const { tweetContexts } = await executable.harvestFullTexts(cdp, [id], {
      handle: 'thsottiaux', gapMs: 0, settleMs: 0, knownTweets: known,
    });
    const tweets = mergeTweetBatch(known, mergeTweetContexts([completion], tweetContexts, known));
    return { visited, event: confirmedResetEvent(tweets.find((t) => t.id === id), { tweets }) };
  }
  const source = await readFile(resolve(ROOT, 'src/lib/browser.mjs'), 'utf8');
  const hash = sha256(source);
  const result = await replay(source);
  check('仅新采到 Done 时继续打开 Landing tomorrow 父帖补链', result.visited.includes(reply.id));
  check('三层完成链最终可形成确认事件', result.event?.type === 'reset' && result.event.context_evidence.length === 2);
  const broken = source.replace("if (ref && isFullTextContextCandidate(ref.text ?? '')) {", 'if (false) {');
  assert.notEqual(source, broken, '跟随父帖变异点存在');
  const failure = await replay(broken);
  check('隔离变异：停止补父帖会使三层完成链断开', !failure.event && !failure.visited.includes(reply.id));
  check('三层链回放不改写采集源码', sha256(await readFile(resolve(ROOT, 'src/lib/browser.mjs'), 'utf8')) === hash);
}

/* ========== 5. 增量合并：不让弱采集抹掉已核验上下文 ========== */

console.log('\n【5】增量保留已核验关系');

{
  const verifiedParent = {
    id: '2113492187770175603', account: 'thsottiaux', text: 'Day 18/ ... reset!',
    created_at: '2026-10-23T04:46:19.000Z', relation: 'reply', verified: true,
  };
  const base = [{
    id: '2113492502355562875', text: 'Landing tomorrow before 10am PST together with a small ship.',
    created_at: '2026-10-23T04:47:34.000Z', inReplyTo: verifiedParent,
    role: 'reply', foundVia: 'with-replies', first_seen: '2026-10-23T05:00:00.000Z',
  }];
  const weakRefresh = mergeTweetBatch(base, [{
    id: base[0].id, text: base[0].text, created_at: base[0].created_at,
    inReplyTo: null, role: 'post', foundVia: 'timeline-browser',
  }], '2026-10-24T05:00:00.000Z')[0];
  check('后续无上下文的增量采集保留原核验父帖', weakRefresh.inReplyTo?.id === verifiedParent.id);
  check('保留的核验上下文与 role=reply 一致', weakRefresh.role === 'reply');
  check('普通字段仍按新采集更新', weakRefresh.foundVia === 'timeline-browser');
  check('first_seen 仍保留首次发现时间', weakRefresh.first_seen === base[0].first_seen);

  const replacement = { ...verifiedParent, id: '2113492187770175604', text: 'Corrected parent', created_at: '2026-10-23T04:46:20.000Z' };
  const verifiedRefresh = mergeTweetBatch(base, [{
    id: base[0].id, text: base[0].text, created_at: base[0].created_at,
    inReplyTo: replacement, role: 'reply', foundVia: 'with-replies',
  }])[0];
  check('新的详情页核验关系允许纠正旧父帖', verifiedRefresh.inReplyTo?.id === replacement.id);

  const collectSource = await readFile(resolve(ROOT, 'src/lib/collect.mjs'), 'utf8');
  const before = sha256(collectSource);
  const collectMutant = collectSource.replace(
    'const keepPrevContext = isVerifiedReply(prev.inReplyTo) && !isVerifiedReply(t.inReplyTo);',
    'const keepPrevContext = false;',
  );
  assert.notEqual(collectMutant, collectSource, '已核验关系保护变异点存在');
  const collectUrl = (path) => new URL(path, `file://${ROOT}/src/lib/collect.mjs`).href;
  const executableCollectMutant = collectMutant
    .replaceAll("'./signals.mjs'", JSON.stringify(collectUrl('./signals.mjs')))
    .replaceAll("'./browser.mjs'", JSON.stringify(collectUrl('./browser.mjs')))
    .replaceAll("'./proxy.mjs'", JSON.stringify(collectUrl('./proxy.mjs')));
  const brokenCollect = await sourceModule(executableCollectMutant);
  const brokenMerge = brokenCollect.mergeTweetBatch(base, [{
    id: base[0].id, text: base[0].text, created_at: base[0].created_at,
    inReplyTo: null, role: 'post', foundVia: 'timeline-browser',
  }])[0];
  check('隔离变异：移除上下文保护会被增量合并断言拦住',
    brokenMerge.inReplyTo?.id !== verifiedParent.id && brokenMerge.role !== 'reply');
  check('采集源码变异仅在内存中执行', sha256(await readFile(resolve(ROOT, 'src/lib/collect.mjs'), 'utf8')) === before);
}

/* ========== 6. 接线：纯函数再对，调用点被删也一样白搭 ========== */

console.log('\n【6】接线（源码级断言）');

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
  const idxPatch = collectSrc.indexOf('const { tweets: fullTweets } = patchTruncatedTexts(');
  const idxClassify = collectSrc.indexOf('kind: classify(t.text)', idxPatch);
  check(
    '采集出口：先补全正文、再 classify（顺序不能反）',
    idxPatch > 0 && idxClassify > idxPatch,
    `patch@${idxPatch} classify@${idxClassify}`
  );
  check('主流程把详情页全文接进执行结果', /detailText = r\.fullTexts/.test(collectSrc));
  check('详情页补全的成败写进 stats 留档（坏了要看得出来）', /fullText: fullTextReport/.test(collectSrc));
  check('详情采集结果通过报告汇总函数留档', /report: makeFullTextReport\(candidates\.length, fullTexts\.size, skipped, scanned\)/.test(browserSrc));
  check(
    '已补全的正文有挡板（不然全量回补每 72 小时把全文打回半句）',
    /prev\.text_full === true/.test(collectSrc)
  );
  check('CLI 有开关可以关掉它', /--no-full-text/.test(cliSrc) && /fullText: !argv\.includes\('--no-full-text'\)/.test(cliSrc));
  check('CLI 会把补全结果打出来', /正文补全/.test(cliSrc));
  const hasMissingContextWarning = (source) =>
    /if \(f\.missingReplyContext\?\.length\) \{[\s\S]*?const ids = f\.missingReplyContext;[\s\S]*?console\.log\([\s\S]*?缺少核验回复上下文 \$\{ids\.length\} 条/.test(source);
  check('CLI 将缺少核验上下文作为普通 stdout 警告输出', hasMissingContextWarning(cliSrc));
  check('缺少上下文警告不设置采集失败状态',
    !/if \(f\.missingReplyContext\?\.length\) \{[^}]*?(?:throw |process\.exitCode|result\.ok\s*=)/s.test(cliSrc));
  const cliHash = sha256(cliSrc);
  const disabledWarningMutant = cliSrc.replace(
    'if (f.missingReplyContext?.length) {',
    'if (false) {',
  );
  assert.notEqual(disabledWarningMutant, cliSrc, 'CLI 警告条件变异点存在');
  check('隔离变异：关闭 stdout 警告会被接线断言拦住', !hasMissingContextWarning(disabledWarningMutant));
  check('CLI 源码变异仅在内存中执行', sha256(await readFile(resolve(ROOT, 'scripts/collect.mjs'), 'utf8')) === cliHash);
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
