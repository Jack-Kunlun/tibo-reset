#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseTweets, fetchLiveTweets, assessFullScanCoverage, FULL_SCAN_RETRY_HOURS,
} from '../src/lib/collect.mjs';
import { resetProxyCache } from '../src/lib/proxy.mjs';
import { renderCollectWarning } from '../src/lib/render.mjs';

const sourceUrl = new URL('../src/lib/collect.mjs', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');
const oldAt = '2026-11-09T04:03:53.079Z';
const post = (id, text, account = 'thsottiaux') => ({
  __typename: 'Tweet', rest_id: id,
  core: { user_results: { result: { __typename: 'User', core: {
    screen_name: account, created_at_ms: Date.parse('2025-08-07T06:07:07Z'),
  } } } },
  details: { full_text: text, created_at_ms: Date.parse('2026-11-13T02:09:55Z') },
});
const quoted = post('9002', 'Someone else has reset their account', 'someone');
const original = { ...post('9001', 'A question about Codex.\n"Hello" \\ world'), quoted_status_result: { result: quoted } };
const payload = (...posts) => `<script>result:{kind:"Result.Ok",value:${JSON.stringify(JSON.stringify({
  data: { timeline: { entries: posts.map(result => ({ tweet_results: { result } })) } },
}))}}</script>`;
const verifyStructured = parse => {
  assert.deepEqual(parse(payload(original, original)), [{
    id: '9001', text: original.details.full_text, account: 'thsottiaux', created_at: '2026-11-13T02:09:55.000Z',
  }]);
  assert.deepEqual(parse(payload({ ...original, details: { full_text: 'Missing timestamp' } })), []);
  assert.deepEqual(parse(payload({ ...original, retweeted_status_result: { result: quoted } })), []);
  assert.deepEqual(parse(payload({ ...original, core: {} })), []);
  assert.deepEqual(parse('<script>value:"broken JSON"</script>'), []);
};
verifyStructured(parseTweets);
console.log('✓ 嵌套 SSR 按本帖配对作者/正文/时间，引用不串入、转推不冒充、去重并拒绝残缺数据');

const previousFetch = globalThis.fetch;
const previousProxy = process.env.X_PROXY;
process.env.X_PROXY = 'off';
resetProxyCache();
let liveHtml = '';
let upstream = [];
globalThis.fetch = async url => ({ ok: true, text: async () =>
  String(url).startsWith('https://codex-resets.com/') ? JSON.stringify({ data: upstream }) : liveHtml });

async function isolated(text, browser = null) {
  // 只替换浏览器边界，真实 HTTP 适配器、解析、合并、错误传播和原子落盘仍一起执行。
  const imported = text.replace("import { collectStreams } from './browser.mjs';", browser
    ? `const collectStreams = async (opts) => {
        const result = ${JSON.stringify(browser)};
        globalThis.__tiboCollectStreamsOptions = {
          knownIds: opts.knownIds == null ? null : Array.from(opts.knownIds),
          maxSteps: opts.maxSteps, settleMs: opts.settleMs,
        };
        if ((Array.isArray(opts.knownIds) && opts.knownIds.length) || opts.knownIds?.size) {
          for (const stream of result.streams) if (stream) stream.mode = 'incremental';
        }
        return result;
      };`
    : "const collectStreams = async () => { throw new Error('Chrome profile 未登录 x.com'); };")
    .replace(/from (['"])(\.[^'"]+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, sourceUrl).href}${quote}`);
  return import('data:text/javascript;base64,' + Buffer.from(imported).toString('base64'));
}

const oldTweet = { id: '8001', text: 'Earlier news', created_at: '2026-11-08T02:00:00Z',
  account: 'thsottiaux', foundVia: 'timeline-browser', role: 'post' };
const oldLive = { tweets: [oldTweet], updated_at: oldAt, source: 'browser', coverage_since: '2026-10-24T00:00:00Z' };
async function collect(module, html, savedLive = oldLive, options = {}, savedStats = {}) {
  liveHtml = html;
  globalThis.__tiboCollectStreamsOptions = null;
  const dir = await mkdtemp(join(tmpdir(), 'tibo-collection-health-'));
  try {
    await writeFile(join(dir, 'tweets.json'), JSON.stringify(savedLive));
    await writeFile(join(dir, 'resets.json'), JSON.stringify({ records: [{
      id: '7001', type: 'reset', announced_at: '2026-10-25T06:06:16Z', text: 'Reset all propagated.',
    }] }));
    await writeFile(join(dir, 'stats.json'), JSON.stringify({ last_full_at: oldAt, generated_at: oldAt,
      collect: { source: 'browser', mode: 'full' }, ...savedStats }));
    const result = await module.runCollection({ dataDir: dir, browser: true, ...options });
    return {
      result,
      live: JSON.parse(await readFile(join(dir, 'tweets.json'), 'utf8')),
      stats: JSON.parse(await readFile(join(dir, 'stats.json'), 'utf8')),
      browserOptions: globalThis.__tiboCollectStreamsOptions,
    };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const verifyEmpty = async module => {
  const { result, live, stats } = await collect(module, '<html>HTTP 200 but no readable tweets</html>');
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /未解析到有效推文.*Chrome profile 未登录/);
  assert.deepEqual(live, oldLive);
  assert.equal(stats.last_full_at, oldAt);
  assert.notEqual(stats.generated_at, oldAt);
  assert.equal(stats.collect.mode, 'failed');
  assert.ok(!stats.collect.carriedOver);
  assert.match(renderCollectWarning({ errors: stats.errors, lastLiveAt: live.updated_at }), /数据采集异常/);
};
const verifyPartial = async module => {
  const { result, live, stats } = await collect(module, payload(original));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /采集覆盖不完整.*未登录.*回复与完整时间线未更新/);
  assert.equal(live.tweets.length, 2);
  assert.equal(live.tweets.find(t => t.id === '9001').foundVia, 'timeline');
  assert.equal(live.updated_at, oldAt);
  assert.equal(live.coverage_since, oldLive.coverage_since);
  assert.equal(live.source, 'html');
  assert.match(live.degraded, /未登录/);
  assert.equal(stats.last_full_at, oldAt);
  assert.equal(stats.collect.mode, 'degraded');
};
const verifyPatchedHistory = async module => {
  const prefix = 'Earlier news about the product. '.repeat(10) + 'Further notes';
  const stored = { ...oldLive, tweets: [{ ...oldTweet, text: prefix, truncated: true }] };
  upstream = [{ id: oldTweet.id, text: prefix + 'This concludes the release notes.', announced_at: oldTweet.created_at }];
  try {
    const { result, live } = await collect(module, '', stored);
    assert.equal(result.history.patchedTexts, 1, '确实执行历史正文补全分支');
    assert.equal(live.tweets[0].text, upstream[0].text);
    assert.equal(live.updated_at, oldAt, '补全文不能推进完整时间线成功时刻');
    assert.equal(result.ok, false);
  } finally { upstream = []; }
};
const verifyNoBrowser = async module => {
  const { result, live } = await collect(module, payload(original), oldLive, { browser: false });
  assert.equal(result.ok, false);
  assert.equal(live.source, 'html');
  assert.equal(live.degraded, '未使用登录态浏览器');
  assert.equal(live.updated_at, oldAt);
};
const verifyTrustedFallback = async module => {
  const { live } = await collect(module, payload(post(oldTweet.id, 'Changed unverified text')));
  assert.deepEqual(live.tweets, oldLive.tweets, '首屏不能改写已核验帖的正文、时刻和来源');
};

const scanFloor = Date.parse('2026-10-25T06:06:16.000Z') - 24 * 60 * 60 * 1000;
const scanFloorIso = new Date(scanFloor).toISOString();
const reachedStream = (overrides = {}) => ({
  loggedIn: true, mode: 'full', stoppedBy: 'floor',
  oldest: new Date(scanFloor - 60_000).toISOString(),
  tweets: [oldTweet], steps: 20, ...overrides,
});
const stalledReplyPosts = Array.from({ length: 10 }, (_, index) => ({
  ...oldTweet,
  id: String(8100 + index),
  text: `Reply ${index}`,
  created_at: new Date(scanFloor + (index + 1) * 60 * 60 * 1000).toISOString(),
  role: 'reply',
  inReplyTo: { id: `900${index}`, account: 'other', text: 'Context', created_at: oldTweet.created_at },
}));

const fullBrowserResult = (main = reachedStream(), reply = reachedStream(), errors = [null, null]) => ({
  streams: [main, reply], errors,
});

async function verifyIncompleteFull(scan, expectedReason) {
  const module = await isolated(source, scan);
  const legacyLastFullAt = '2099-01-01T00:00:00.000Z';
  const { result, live, stats } = await collect(module, '', oldLive, {}, {
    last_full_at: legacyLastFullAt, // 旧时间戳很新也不能证明全量已完成
  });
  assert.equal(result.mode, 'full', '旧 last_full_at 不应把本轮压成增量');
  assert.equal(result.fullScan.complete, false);
  assert.match(result.fullScan.reason, expectedReason);
  assert.equal(stats.last_full_at, legacyLastFullAt, '不完整轮次不得改写旧全量水位');
  assert.equal(stats.full_scan, null, '不完整轮次不能生成完整覆盖证明');
  assert.equal(live.coverage_since, oldLive.coverage_since, '不完整轮次不能推进 coverage_since');
  return { result, live, stats };
}

try {
  const completeReply = assessFullScanCoverage(
    scanFloor,
    reachedStream(),
    reachedStream(),
  );
  assert.equal(completeReply.complete, true, '两条登录态时间线都越过下界才算完成');
  for (const [name, main, reply, error] of [
    ['原创 no-more', reachedStream({ stoppedBy: 'no-more', oldest: new Date(scanFloor + 60_000).toISOString() }), reachedStream()],
    ['原创 exhausted', reachedStream({ stoppedBy: 'exhausted' }), reachedStream()],
    ['原创 known', reachedStream({ stoppedBy: 'known' }), reachedStream()],
    ['回复 no-more', reachedStream(), reachedStream({ stoppedBy: 'no-more', oldest: new Date(scanFloor + 60_000).toISOString() })],
    ['回复 exhausted', reachedStream(), reachedStream({ stoppedBy: 'exhausted' })],
    ['回复 known', reachedStream(), reachedStream({ stoppedBy: 'known' })],
    ['回复禁用', reachedStream(), null],
    ['回复错误', reachedStream(), null, 'Chrome tab failed'],
    ['未登录原创流', reachedStream(), reachedStream({ loggedIn: false })],
    ['未登录回复流', reachedStream(), reachedStream({ loggedIn: false })],
    ['无下界', null, reachedStream()],
  ]) {
    const floor = name === '无下界' ? 0 : scanFloor;
    assert.equal(assessFullScanCoverage(floor, main, reply, error).complete, false, `${name} 不能完成全量证明`);
  }
  assert.equal(assessFullScanCoverage(scanFloor, reachedStream(),
    reachedStream({ oldest: new Date(scanFloor + 60_000).toISOString() })).complete, false,
  'stop=floor 但实际最早时刻仍在下界之后不能算完成');
  console.log('✓ 全量覆盖必须由原创与回复两条登录态流分别证明到达真实下界');

  liveHtml = payload(quoted);
  await assert.rejects(fetchLiveTweets(), /未解析到有效推文/);
  liveHtml = payload(original, quoted);
  assert.deepEqual((await fetchLiveTweets()).map(t => t.id), ['9001']);
  console.log('✓ 首屏过滤其他作者，只有其他作者时不能当作成功采集');
  const module = await isolated(source);
  await verifyEmpty(module);
  console.log('✓ HTTP 200 空解析传播失败、保留成功时刻、落盘错误并显示异常');
  await verifyPartial(module);
  console.log('✓ 有效首屏可补原文但仍告警，不推进完整采集时间或全量水位');
  await verifyPatchedHistory(module);
  console.log('✓ 主链路失败时历史正文仍可补全，但不推进完整采集时间');
  await verifyNoBrowser(module);
  console.log('✓ 显式免登录模式仍在推文元数据中标记降级');
  await verifyTrustedFallback(module);
  console.log('✓ 免登录首屏不能覆盖已核验原帖，也不擦掉活动来源');
  const browser = await isolated(source, { streams: [{ loggedIn: true, tweets: [oldTweet],
    mode: 'incremental', stoppedBy: 'known' }, { tweets: [oldTweet], mode: 'incremental' }], errors: [] });
  const existingProof = {
    version: 1, status: 'complete', completed_at: new Date().toISOString(),
    coverage_since: scanFloorIso, main: { complete: true }, reply: { complete: true },
  };
  const success = await collect(browser, '', oldLive, {}, {
    full_scan: existingProof,
  });
  assert.equal(success.result.ok, true);
  assert.equal(success.result.mode, 'incremental');
  assert.equal(success.result.fullScan, null);
  assert.equal(success.stats.collect.newTweets, 0);
  assert.notEqual(success.live.updated_at, oldAt);
  assert.equal(success.live.source, 'browser');
  assert.deepEqual(success.stats.errors, []);
  assert.deepEqual(success.stats.full_scan, existingProof, '增量轮保留最近一次可验证的全量证明');
  assert.deepEqual(success.browserOptions, {
    knownIds: [oldTweet.id], maxSteps: 60, settleMs: 800,
  }, '增量只使用短预算');
  console.log('✓ 登录态增量读到全是旧帖仍成功，零新增不等于零解析');

  const fullRows = [oldTweet, ...stalledReplyPosts];
  const completedFull = await collect(await isolated(source, fullBrowserResult(
    reachedStream(), reachedStream({ tweets: fullRows }),
  )), '');
  assert.equal(completedFull.result.fullScan.complete, true);
  assert.equal(completedFull.result.coverageSince, scanFloorIso);
  assert.equal(completedFull.stats.full_scan.status, 'complete');
  assert.equal(completedFull.stats.full_scan.coverage_since, scanFloorIso);
  assert.equal(completedFull.stats.full_scan_attempt.complete, true);
  assert.equal(completedFull.stats.full_scan_attempt.requested_since, scanFloorIso);
  assert.equal(completedFull.live.tweets.length, 11, '完成全量证明时仍并入原创与回复数据');
  assert.deepEqual(completedFull.browserOptions, {
    knownIds: null, maxSteps: 400, settleMs: 2_000,
  }, '全量须传递深扫描的有界预算');
  console.log('✓ 双流实际到达时间下界后才写入完成水位与版本化证明');

  const explicitBudget = await collect(await isolated(source, fullBrowserResult(
    reachedStream(), reachedStream({ tweets: fullRows }),
  )), '', oldLive, { full: true, maxSteps: 237 });
  assert.deepEqual(explicitBudget.browserOptions, {
    knownIds: null, maxSteps: 237, settleMs: 2_000,
  }, '显式 maxSteps 覆盖全量默认步数');
  console.log('✓ 默认全量400步/2秒、增量60步/800毫秒，显式步数优先');

  const incomplete = await verifyIncompleteFull(fullBrowserResult(
    reachedStream(), reachedStream({
      stoppedBy: 'no-more',
      oldest: new Date(scanFloor + 60 * 60 * 1000).toISOString(),
      tweets: fullRows,
    }),
  ), /回复时间线尚未到达时间下界/);
  assert.equal(incomplete.live.tweets.length, 11, '回复流未到下界时仍保留已收下的十条回复');
  assert.equal(incomplete.result.reply.harvested, 11);
  assert.equal(incomplete.stats.full_scan_attempt.complete, false, '记录未完成尝试以控制后续回补频率');
  assert.equal(incomplete.stats.full_scan_attempt.requested_since, scanFloorIso);
  console.log('✓ 回复流 no-more 仅标记未完成，保留已采集数据且不推进水位');

  assert.equal(FULL_SCAN_RETRY_HOURS, 6);
  const retryBrowser = await isolated(source, fullBrowserResult(
    reachedStream(), reachedStream({ tweets: fullRows }),
  ));
  const recentRetry = await collect(retryBrowser, '', incomplete.live, {}, incomplete.stats);
  assert.equal(recentRetry.result.mode, 'incremental', '同一下界失败后六小时内不重复慢速全量回补');
  assert.equal(recentRetry.result.fullScan, null);
  const verifyThrownAttempt = async (module, html) => {
    const failed = await collect(module, html);
    assert.equal(failed.stats.full_scan_attempt?.complete, false, '浏览器抛错仍记录失败尝试');
    assert.equal(failed.stats.full_scan_attempt.requested_since, scanFloorIso);
    assert.ok(Number.isFinite(Date.parse(failed.stats.full_scan_attempt.attempted_at)));
    assert.equal(failed.stats.full_scan, null);
    assert.equal(failed.stats.last_full_at, oldAt);
    assert.equal(failed.live.updated_at, oldAt);
    const next = await collect(retryBrowser, '', failed.live, {}, failed.stats);
    assert.equal(next.result.mode, 'incremental', '启动/CDP 失败后的下轮也遵守六小时回补冷却');
    return failed;
  };
  for (const html of ['', payload(original)]) {
    const failed = await verifyThrownAttempt(await isolated(source), html);
    assert.match(failed.stats.full_scan_attempt.reason, /Chrome profile 未登录/);
  }
  const proxyFailure = source.replace('proxy: await resolveProxy(),',
    "proxy: await Promise.reject(new Error('proxy probe failed')),");
  assert.notEqual(proxyFailure, source, '代理异常测试必须命中采集入口');
  assert.match((await verifyThrownAttempt(await isolated(proxyFailure), '')).stats.full_scan_attempt.reason, /proxy probe failed/);
  const forgetThrownAttempt = source.replace('if (wantFull) fullScanAttemptAt = new Date().toISOString();', '');
  assert.notEqual(forgetThrownAttempt, source);
  await assert.rejects(verifyThrownAttempt(await isolated(forgetThrownAttempt), ''), undefined,
    '丢失启动失败尝试的源码变异必须被拦截');
  console.log('✓ 启动、CDP 与代理异常均记录失败尝试；降级成功或失败均保持六小时回补冷却');
  const forcedRetry = await collect(retryBrowser, '', incomplete.live, { full: true }, incomplete.stats);
  assert.equal(forcedRetry.result.mode, 'full', '--full 可立即绕过失败冷却');
  assert.equal(forcedRetry.result.fullScan.complete, true);

  const staleAttemptStats = {
    full_scan_attempt: {
      attempted_at: new Date(Date.now() - 6 * 60 * 60 * 1000 - 1000).toISOString(),
      requested_since: scanFloorIso, complete: false,
    },
  };
  const elapsedRetry = await collect(retryBrowser, '', incomplete.live, {}, staleAttemptStats);
  assert.equal(elapsedRetry.result.mode, 'full', '失败冷却满六小时后自动重试');
  assert.equal(elapsedRetry.result.fullScan.complete, true);

  const expiredProof = {
    version: 1, status: 'complete',
    completed_at: new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString(),
    coverage_since: scanFloorIso, main: { complete: true }, reply: { complete: true },
  };
  const expiredProofWaitingRetry = await collect(retryBrowser, '', incomplete.live, {}, {
    full_scan: expiredProof,
    full_scan_attempt: {
      attempted_at: new Date().toISOString(), requested_since: scanFloorIso,
      complete: false, reason: 'reply no-more',
    },
  });
  assert.equal(expiredProofWaitingRetry.result.mode, 'incremental',
    '过期证明后的失败尝试仍按六小时退避，不能每轮重复全量');
  const expiredProofNoAttempt = await collect(retryBrowser, '', incomplete.live, {}, {
    full_scan: expiredProof,
  });
  assert.equal(expiredProofNoAttempt.result.mode, 'full', '72 小时成功证明过期后再次全量回补');

  const broadenedRetry = await collect(retryBrowser, '', incomplete.live, {}, {
    full_scan_attempt: {
      attempted_at: new Date().toISOString(),
      requested_since: new Date(scanFloor + 60 * 60 * 1000).toISOString(),
      complete: false,
    },
  });
  assert.equal(broadenedRetry.result.mode, 'full', '请求更早的下界时旧尝试范围不能阻挡立即回补');
  console.log('✓ 未完成尝试六小时后重试；显式全量与扩大回溯范围立即重试');

  const fullBudgetMutation = source.replace(
    'const FULL_SCAN_MAX_STEPS = 400;',
    'const FULL_SCAN_MAX_STEPS = 60;',
  );
  assert.notEqual(fullBudgetMutation, source, '全量预算变异点存在');
  await assert.rejects(async () => {
    const mutant = await isolated(fullBudgetMutation, fullBrowserResult(
      reachedStream(), reachedStream({ tweets: fullRows }),
    ));
    const result = await collect(mutant, '');
    assert.equal(result.browserOptions.maxSteps, 400, '全量深扫预算必须保留');
  }, undefined, '缩小全量默认预算的源码反例必须失败');

  const explicitStepsMutation = source.replace(
    'maxSteps: opts.maxSteps ?? (fullScan ? FULL_SCAN_MAX_STEPS : INCREMENTAL_MAX_STEPS),',
    'maxSteps: fullScan ? FULL_SCAN_MAX_STEPS : INCREMENTAL_MAX_STEPS,',
  );
  assert.notEqual(explicitStepsMutation, source, '显式步数优先级变异点存在');
  await assert.rejects(async () => {
    const mutant = await isolated(explicitStepsMutation, fullBrowserResult(
      reachedStream(), reachedStream({ tweets: fullRows }),
    ));
    const result = await collect(mutant, '', oldLive, { full: true, maxSteps: 237 });
    assert.equal(result.browserOptions.maxSteps, 237, '调用方显式步数应优先');
  }, undefined, '移除显式 maxSteps 优先级的源码反例必须失败');
  console.log('✓ 源码反例拦截全量预算回退和显式步数失效');

  const badOldestMutation = source.replace(
    'Number.isFinite(oldestMs) && oldestMs <= floor',
    'Number.isFinite(oldestMs)',
  );
  assert.notEqual(badOldestMutation, source, '真实最早时刻断言变异锚点存在');
  await assert.rejects(async () => {
    const mutant = await isolated(badOldestMutation);
    const result = mutant.assessFullScanCoverage(scanFloor, reachedStream(), reachedStream({
      oldest: new Date(scanFloor + 60_000).toISOString(),
    }));
    assert.equal(result.complete, false, 'stop=floor 但最早时间仍越不过下界');
  }, undefined, '移除真实最早时刻判据的变异必须失败');

  const replyMutation = source.replace(
    'mainCoverage.complete && replyCoverage.complete && !replyError',
    'mainCoverage.complete && !replyError',
  );
  assert.notEqual(replyMutation, source, '回复流覆盖判据变异锚点存在');
  await assert.rejects(async () => {
    const mutant = await isolated(replyMutation);
    const result = mutant.assessFullScanCoverage(scanFloor, reachedStream(), reachedStream({
      stoppedBy: 'no-more', oldest: new Date(scanFloor + 60_000).toISOString(),
    }));
    assert.equal(result.complete, false, '回复流未到下界');
  }, undefined, '移除回复流判据的变异必须失败');
  console.log('✓ 两个隔离反例分别拦截“伪造下界”和“漏查回复流”');

  for (const [name, from, to, verify] of [
    ['嵌套载荷分支缺失', 'if (tweets.length) return', 'if (false) return', async m => verifyStructured(m.parseTweets)],
    ['引用正文串入本帖', 'const text = node.details?.full_text;', 'const text = node.quoted_status_result?.result?.details?.full_text ?? node.details?.full_text;', async m => verifyStructured(m.parseTweets)],
    ['空结果被当作成功', "if (!tweets.length) throw new Error('免登录首屏未解析到有效推文，页面结构可能变化或访问受限');", '', verifyEmpty],
    ['部分采集推进成功时间', "liveSource === 'browser' ? new Date().toISOString() : (live.updated_at ?? null)", 'new Date().toISOString()', verifyPartial],
    ['降级被当作成功', "if (liveSource === 'html') {", 'if (false) {', verifyPartial],
    ['历史正文补全伪装成完整采集', 'live = { ...live, tweets: r.tweets };', 'live = { ...live, tweets: r.tweets, updated_at: new Date().toISOString() };', verifyPatchedHistory],
    ['主动免登录时丢失降级原因', "if (liveSource === 'html') next.degraded", "if (liveSource === 'html' && browserError) next.degraded", verifyNoBrowser],
    ['首屏覆盖已核验来源', "if (t.foundVia === 'timeline' && ['timeline-browser', 'with-replies', 'manual'].includes(prev.foundVia)) continue;", '', verifyTrustedFallback],
  ]) {
    assert.ok(source.includes(from), name + '变异锚点存在');
    await assert.rejects(verify(await isolated(source.replace(from, to))), undefined, name + '必须被回归拦住');
    console.log('✓ 隔离反例被拦住：' + name);
  }
} finally {
  globalThis.fetch = previousFetch;
  if (previousProxy === undefined) delete process.env.X_PROXY;
  else process.env.X_PROXY = previousProxy;
  resetProxyCache();
}
assert.equal(hash(await readFile(sourceUrl, 'utf8')), hash(source));
console.log('✓ 采集健康回归通过；8 个隔离反例被拦住，真实数据与源码未被测试改写');
