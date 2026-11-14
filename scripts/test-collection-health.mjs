#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseTweets, fetchLiveTweets } from '../src/lib/collect.mjs';
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
    ? `const collectStreams = async () => (${JSON.stringify(browser)});`
    : "const collectStreams = async () => { throw new Error('Chrome profile 未登录 x.com'); };")
    .replace(/from (['"])(\.[^'"]+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, sourceUrl).href}${quote}`);
  return import('data:text/javascript;base64,' + Buffer.from(imported).toString('base64'));
}

const oldTweet = { id: '8001', text: 'Earlier news', created_at: '2026-11-08T02:00:00Z',
  account: 'thsottiaux', foundVia: 'timeline-browser', role: 'post' };
const oldLive = { tweets: [oldTweet], updated_at: oldAt, source: 'browser', coverage_since: '2026-10-24T00:00:00Z' };
async function collect(module, html, savedLive = oldLive, options = {}) {
  liveHtml = html;
  const dir = await mkdtemp(join(tmpdir(), 'tibo-collection-health-'));
  try {
    await writeFile(join(dir, 'tweets.json'), JSON.stringify(savedLive));
    await writeFile(join(dir, 'resets.json'), JSON.stringify({ records: [{
      id: '7001', type: 'reset', announced_at: '2026-10-25T06:06:16Z', text: 'Reset all propagated.',
    }] }));
    await writeFile(join(dir, 'stats.json'), JSON.stringify({ last_full_at: oldAt, generated_at: oldAt,
      collect: { source: 'browser', mode: 'full' } }));
    const result = await module.runCollection({ dataDir: dir, browser: true, ...options });
    return { result, live: JSON.parse(await readFile(join(dir, 'tweets.json'), 'utf8')),
      stats: JSON.parse(await readFile(join(dir, 'stats.json'), 'utf8')) };
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

try {
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
  const success = await collect(browser, '');
  assert.equal(success.result.ok, true);
  assert.equal(success.stats.collect.newTweets, 0);
  assert.notEqual(success.live.updated_at, oldAt);
  assert.equal(success.live.source, 'browser');
  assert.deepEqual(success.stats.errors, []);
  console.log('✓ 登录态增量读到全是旧帖仍成功，零新增不等于零解析');

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
