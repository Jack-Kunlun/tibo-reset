#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAutoTranslator,
  selectTranslationTweets,
  splitTranslationText,
  TRANSLATION_CACHE_FILE,
} from '../src/lib/auto-translations.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const quiet = () => {};
const quotaNow = Date.parse('2026-10-24T00:00:00.000Z');
const root = await mkdtemp(join(tmpdir(), 'tibo-auto-translation-'));
const directories = [];
async function newDir(name) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  directories.push(path);
  return path;
}
function tweet(id, text, overrides = {}) {
  return {
    id: String(id), account: 'thsottiaux', author_verified: true,
    foundVia: 'timeline-browser', text, created_at: '2026-10-24T00:00:00.000Z',
    ...overrides,
  };
}
function signalsFor(ids = []) {
  return {
    generatedAt: '2026-10-24T00:00:00.000Z',
    calendar: { plan: { rows: [{ entries: ids.map((id) => ({ id: String(id) })) }] } },
    forecasts: [], overdueForecasts: [], observedForecasts: [], occurred: [], hints: [],
  };
}
function response(translatedText, { status = 200, responseStatus = 200 } = {}) {
  return { status, json: async () => ({ responseStatus, responseData: { translatedText } }) };
}
async function cacheAt(dataDir) {
  return JSON.parse(await readFile(join(dataDir, TRANSLATION_CACHE_FILE), 'utf8'));
}

try {
  const older = tweet('1001', 'An old update');
  const relevant = tweet('1002', 'Day 20 / Reset tomorrow');
  const notVerified = tweet('1003', 'Reset tomorrow', { author_verified: false });
  const otherAccount = tweet('1004', 'Reset tomorrow', { account: 'someone-else' });
  const wrongSource = tweet('1005', 'Reset tomorrow', { foundVia: 'timeline' });
  const manual = tweet('1006', 'Reset tomorrow', { foundVia: 'manual', account: 'manual' });
  const plainMention = tweet('1007', 'I hope they reset soon');
  const filtered = selectTranslationTweets(
    [older, relevant, notVerified, otherAccount, wrongSource, manual, plainMention],
    { ...signalsFor(['1002']), hints: [{ id: '1007' }] },
  );
  assert.deepEqual(filtered.map((item) => item.id), ['1002'], '只选可信且被计划/重置证据引用的帖子，提示不能单独入队');

  const recent = tweet('1008', 'The reset happened', { created_at: '2026-10-23T12:00:00.000Z' });
  const stale = tweet('1009', 'The reset happened', { created_at: '2026-10-22T00:00:00.000Z' });
  const occurredSignals = {
    ...signalsFor(),
    occurred: [
      { id: '1008', occurredAt: '2026-10-23T12:00:00.000Z' },
      { id: '1009', occurredAt: '2026-10-22T00:00:00.000Z' },
    ],
  };
  assert.deepEqual(selectTranslationTweets([recent, stale], occurredSignals).map((item) => item.id), ['1008'],
    '只用 generatedAt 的 24 小时范围补充近期已发生推文');

  const unicode = 'A🙂中'.repeat(180);
  const chunks = splitTranslationText(unicode, 500);
  assert.equal(chunks.join(''), unicode, 'UTF-8 分块完整保留所有字符');
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 500));
  assert.deepEqual(splitTranslationText('hello world', 7), ['hello ', 'world'],
    '空白边界优先于在单词中间切开');
  assert.deepEqual(splitTranslationText('abc.defghi', 5), ['abc.', 'defgh', 'i'],
    '没有空白时使用可用的句末边界');
  assert.throws(() => splitTranslationText('🙂', 3), RangeError);

  const baselineDir = await newDir('baseline');
  let calls = 0;
  const baselineTranslator = createAutoTranslator({
    dataDir: baselineDir, now: () => Date.parse('2026-10-24T00:00:00.000Z'),
    fetchImpl: async (input, init) => {
      calls++;
      const url = new URL(input);
      assert.equal(url.searchParams.get('q'), relevant.text);
      assert.equal(url.searchParams.get('langpair'), 'en|zh-CN');
      assert.equal(url.searchParams.get('mt'), '1');
      assert.deepEqual([...url.searchParams.keys()].sort(), ['langpair', 'mt', 'q']);
      assert.equal(init.method, 'GET');
      const reserved = await cacheAt(baselineDir);
      assert.equal(reserved.usage.characters, Array.from(relevant.text).length,
        '发送前先持久化按码点计数的额度预留');
      return response('译文');
    }, log: quiet,
  });
  await baselineTranslator.initialize([older]);
  await baselineTranslator.enqueue([older]);
  assert.equal(calls, 0, '首次缓存里的旧帖只建立 hash baseline，不批量翻译');
  await baselineTranslator.enqueue([relevant]);
  assert.equal(calls, 1, 'baseline 之后新增相关推文可翻译');
  let baselineCache = await cacheAt(baselineDir);
  assert.equal(baselineCache.entries['1002'].text, '译文');
  assert.equal(baselineCache.entries['1002'].sourceHash, hash(relevant.text));
  assert.equal(baselineCache.revision, 1);
  assert.equal(baselineCache.usage.characters, Array.from(relevant.text).length);

  const restartTranslator = createAutoTranslator({
    dataDir: baselineDir, now: () => Date.parse('2026-10-24T00:01:00.000Z'),
    fetchImpl: async () => { calls++; return response('不应再次请求'); }, log: quiet,
  });
  await restartTranslator.initialize([older, relevant]);
  await restartTranslator.enqueue([relevant]);
  assert.equal(calls, 1, '重启后命中机器缓存不重复收费');
  const edited = { ...relevant, text: `${relevant.text} More detail.` };
  await restartTranslator.enqueue([edited]);
  assert.equal(calls, 2, '全文 hash 改变后同一推文允许重新翻译');
  baselineCache = await cacheAt(baselineDir);
  assert.equal(baselineCache.entries['1002'].sourceHash, hash(edited.text));
  assert.equal(baselineCache.revision, 2);

  const concurrentDir = await newDir('concurrent');
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  let concurrentCalls = 0;
  const concurrentTranslator = createAutoTranslator({
    dataDir: concurrentDir, now: () => Date.parse('2026-10-24T00:00:00.000Z'),
    fetchImpl: async () => {
      concurrentCalls++;
      markFetchStarted();
      await new Promise((resolve) => { releaseFetch = resolve; });
      return response('并发译文');
    }, log: quiet,
  });
  await concurrentTranslator.initialize([]);
  const firstRun = concurrentTranslator.enqueue([relevant]);
  await fetchStarted;
  const duplicateRun = concurrentTranslator.enqueue([relevant]);
  releaseFetch();
  await Promise.all([firstRun, duplicateRun]);
  await concurrentTranslator.idle();
  assert.equal(concurrentCalls, 1, '同一帖的并发入队串行去重');

  const boundedDir = await newDir('bounded-run');
  let boundedCalls = 0;
  const boundedTweets = Array.from({ length: 6 }, (_, index) => tweet(`110${index}`, `相关推文 ${index}`));
  const boundedTranslator = createAutoTranslator({
    dataDir: boundedDir, now: () => quotaNow, maxPostsPerRun: 5,
    fetchImpl: async () => { boundedCalls++; return response('相关译文'); }, log: quiet,
  });
  await boundedTranslator.initialize([]);
  await boundedTranslator.enqueue(boundedTweets);
  assert.equal(boundedCalls, 5, '单轮最多请求五条推文');
  await boundedTranslator.enqueue([boundedTweets[5]]);
  assert.equal(boundedCalls, 6, '未处理项目保留到下一轮入队');

  const quotaDir = await newDir('quota');
  let quotaCalls = 0;
  const quotaTranslator = createAutoTranslator({
    dataDir: quotaDir, now: () => quotaNow,
    fetchImpl: async () => { quotaCalls++; return response('MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY', { responseStatus: 200 }); },
    log: quiet,
  });
  await quotaTranslator.initialize([]);
  await quotaTranslator.enqueue([relevant]);
  let quotaCache = await cacheAt(quotaDir);
  assert.equal(quotaCalls, 1);
  assert.equal(quotaCache.entries['1002'], undefined, '免费额度警告不能伪装成译文缓存');
  assert.equal(quotaCache.revision, 0, '失败不增加译文 revision');
  assert.equal(Date.parse(quotaCache.blockedUntil), quotaNow + 24 * 60 * 60_000);
  await quotaTranslator.enqueue([relevant]);
  assert.equal(quotaCalls, 1, '额度阻断期内不再请求');

  const http429Dir = await newDir('http429');
  const http429 = createAutoTranslator({
    dataDir: http429Dir, now: () => quotaNow,
    fetchImpl: async () => response('quota exceeded', { status: 429, responseStatus: 429 }), log: quiet,
  });
  await http429.initialize([]);
  await http429.enqueue([relevant]);
  assert.equal((await cacheAt(http429Dir)).entries['1002'], undefined, 'HTTP 429 不缓存响应内容');

  const failureCases = [
    ['non-200', async () => response('服务不可用', { status: 503, responseStatus: 503 })],
    ['bad-json', async () => ({ status: 200, json: async () => { throw new Error('bad json'); } })],
    ['empty', async () => response('   ')],
    ['html', async () => response('<!doctype html><html><body>error</body></html>')],
    ['timeout', async (_url, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(response('late result')));
    })],
  ];
  for (const [name, fetchImpl] of failureCases) {
    const dir = await newDir(name);
    const translator = createAutoTranslator({
      dataDir: dir, now: () => quotaNow, requestTimeoutMs: 10, maxRunMs: 100,
      fetchImpl, log: quiet,
    });
    await translator.initialize([]);
    await translator.enqueue([relevant]);
    const cached = await cacheAt(dir);
    assert.equal(cached.entries['1002'], undefined, `${name} 不写入伪译文`);
    if (name !== 'timeout') assert.ok(cached.attempts['1002'], `${name} 进入单帖冷却`);
  }

  const deadlineDir = await newDir('multi-chunk-deadline');
  const deadlinePost = tweet('1012', 'a'.repeat(501));
  let deadlineNow = quotaNow;
  let deadlineCalls = 0;
  const deadlineOptions = {
    dataDir: deadlineDir, now: () => deadlineNow, maxRunMs: 20,
    fetchImpl: async () => {
      deadlineCalls++;
      deadlineNow += 21;
      return response('第一段译文');
    }, log: quiet,
  };
  const deadlineTranslator = createAutoTranslator(deadlineOptions);
  await deadlineTranslator.initialize([]);
  await deadlineTranslator.enqueue([deadlinePost]);
  const deadlineCache = await cacheAt(deadlineDir);
  assert.equal(deadlineCalls, 1, '单轮期限耗尽后不请求后续段落');
  assert.equal(deadlineCache.entries['1012'], undefined, '多段推文未完成时不缓存部分译文');
  assert.equal(deadlineCache.revision, 0);
  assert.equal(deadlineCache.usage.characters, 500, '保留已经请求的段落额度');
  assert.equal(deadlineCache.attempts['1012'].retryAfter,
    new Date(deadlineNow + 15 * 60_000).toISOString(), '中途到达期限也持久化单帖退避');
  await deadlineTranslator.enqueue([deadlinePost]);
  const deadlineRestart = createAutoTranslator(deadlineOptions);
  await deadlineRestart.initialize([]);
  await deadlineRestart.enqueue([deadlinePost]);
  assert.equal(deadlineCalls, 1, '当前实例与重启后的实例均在退避期内保留英文');

  const oversizedTranslationDir = await newDir('oversized-translation');
  const oversizedTranslation = createAutoTranslator({
    dataDir: oversizedTranslationDir, now: () => quotaNow,
    fetchImpl: async () => response('译'.repeat(20_001)), log: quiet,
  });
  await oversizedTranslation.initialize([]);
  await oversizedTranslation.enqueue([relevant]);
  const oversizedCache = await cacheAt(oversizedTranslationDir);
  assert.equal(oversizedCache.entries['1002'], undefined, '超过 20000 字符的最终译文不形成缓存');
  assert.ok(oversizedCache.attempts['1002']);

  const quotaCapDir = await newDir('quota-cap');
  let capCalls = 0;
  const longPost = tweet('1011', 'a'.repeat(501));
  const quotaCap = createAutoTranslator({
    dataDir: quotaCapDir, now: () => quotaNow, dailyLimit: 500,
    fetchImpl: async () => { capCalls++; return response('译文'); }, log: quiet,
  });
  await quotaCap.initialize([]);
  await quotaCap.enqueue([longPost]);
  assert.equal(capCalls, 0, '整帖超过当日剩余额度时，在首块请求前整体跳过');
  assert.equal((await cacheAt(quotaCapDir)).usage.characters, 0);

  const saveFailureDir = await newDir('save-failure');
  const saveFailurePath = join(saveFailureDir, TRANSLATION_CACHE_FILE);
  let saveFailureCalls = 0;
  const saveFailure = createAutoTranslator({
    dataDir: saveFailureDir, now: () => quotaNow,
    fetchImpl: async () => { saveFailureCalls++; return response('不应请求'); }, log: quiet,
  });
  await saveFailure.initialize([]);
  await rm(saveFailurePath);
  await mkdir(saveFailurePath);
  await saveFailure.enqueue([relevant]);
  assert.equal(saveFailureCalls, 0, '额度预留缓存落盘失败时不发网络请求');

  const corruptDir = await newDir('corrupt');
  const corruptPath = join(corruptDir, TRANSLATION_CACHE_FILE);
  await writeFile(corruptPath, '{not json', 'utf8');
  const corruptTranslator = createAutoTranslator({
    dataDir: corruptDir, fetchImpl: async () => { throw new Error('损坏缓存时不应请求'); }, log: quiet,
  });
  await assert.rejects(corruptTranslator.initialize([]), /JSON 损坏/);
  assert.equal(await readFile(corruptPath, 'utf8'), '{not json', '损坏缓存原样保留');

  const invalidEntryDir = await newDir('invalid-entry');
  const invalidEntryPath = join(invalidEntryDir, TRANSLATION_CACHE_FILE);
  const seedInvalidEntry = createAutoTranslator({ dataDir: invalidEntryDir, log: quiet });
  await seedInvalidEntry.initialize([]);
  const invalidEntryCache = await cacheAt(invalidEntryDir);
  invalidEntryCache.entries['1002'] = {
    sourceHash: hash(relevant.text), text: '', language: 'zh-CN', provider: 'mymemory',
    translatedAt: '2026-10-24T00:00:00.000Z',
  };
  const invalidEntryRaw = `${JSON.stringify(invalidEntryCache)}\n`;
  await writeFile(invalidEntryPath, invalidEntryRaw, 'utf8');
  let invalidEntryCalls = 0;
  const invalidEntryTranslator = createAutoTranslator({
    dataDir: invalidEntryDir, fetchImpl: async () => { invalidEntryCalls++; return response('不应请求'); }, log: quiet,
  });
  await assert.rejects(invalidEntryTranslator.initialize([]), /结构无效/);
  assert.equal(await readFile(invalidEntryPath, 'utf8'), invalidEntryRaw, '坏译文条目不被覆盖或当作有效命中');
  await invalidEntryTranslator.enqueue([relevant]);
  assert.equal(invalidEntryCalls, 0, '无效缓存停用本轮，而不是沿同 hash 静默跳过');

  const modulePath = new URL('../src/lib/auto-translations.mjs', import.meta.url);
  const sourceBefore = await readFile(modulePath, 'utf8');
  const sourceHash = hash(sourceBefore);
  async function importMutant(mutated) {
    const portable = mutated.replace("import { translationFor } from './tweet-translations.mjs';", 'const translationFor = () => null;');
    return import(`data:text/javascript;base64,${Buffer.from(portable).toString('base64')}`);
  }
  const unverified = tweet('1010', 'Day 20 / reset', { author_verified: false });
  const unverifiedSignals = signalsFor(['1010']);
  const selectorMutantSource = sourceBefore.replace('tweet.author_verified === true', 'tweet.author_verified !== true');
  assert.notEqual(selectorMutantSource, sourceBefore, '找到实际执行的可信作者闸门');
  const selectorMutant = await importMutant(selectorMutantSource);
  assert.equal(selectTranslationTweets([unverified], unverifiedSignals).length, 0);
  assert.equal(selectorMutant.selectTranslationTweets([unverified], unverifiedSignals).length, 1,
    '隔离移除可信作者闸门后反例会穿透，证明测试能抓住回归');

  const baselineMutantSource = sourceBefore.replace('if (cache.baseline[id] === sourceHash) return;', 'if (false) return;');
  assert.notEqual(baselineMutantSource, sourceBefore, '找到实际执行的 baseline 跳过分支');
  const baselineMutant = await importMutant(baselineMutantSource);
  const mutantDir = await newDir('baseline-mutant');
  let mutantCalls = 0;
  const mutantTranslator = baselineMutant.createAutoTranslator({
    dataDir: mutantDir, now: () => quotaNow,
    fetchImpl: async () => { mutantCalls++; return response('旧帖译文'); }, log: quiet,
  });
  await mutantTranslator.initialize([older]);
  await mutantTranslator.enqueue([older]);
  assert.equal(mutantCalls, 1, '隔离移除 baseline 保护后同一旧帖会被错误翻译');

  const warningMutantSource = sourceBefore.replace(
    'if (Number(response?.status) === 429 || hasQuotaWarning(payload, bodyText)) {',
    'if (false) {',
  ).replace("if (/^\\s*MYMEMORY\\s+(?:WARNING|ERROR)\\s*:/i.test(bodyText)) {", 'if (false) {');
  assert.notEqual(warningMutantSource, sourceBefore, '找到实际执行的额度警告识别分支');
  const warningMutant = await importMutant(warningMutantSource);
  const warningDir = await newDir('quota-mutant');
  const warningTranslator = warningMutant.createAutoTranslator({
    dataDir: warningDir, now: () => quotaNow,
    fetchImpl: async () => response('MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY'), log: quiet,
  });
  await warningTranslator.initialize([]);
  await warningTranslator.enqueue([relevant]);
  assert.equal((await cacheAt(warningDir)).entries['1002'].text,
    'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY',
    '隔离移除额度闸门后警告会被误存为译文，证明配额反例有效');
  assert.equal(hash(await readFile(modulePath, 'utf8')), sourceHash, '隔离变异未改写正式源文件');

  const splitMutantSource = sourceBefore.replace(
    'if (isPreferredBoundary(points[boundary - 1])) preferredEnd = boundary;',
    'if (false) preferredEnd = boundary;',
  );
  assert.notEqual(splitMutantSource, sourceBefore, '找到执行中的自然边界选择分支');
  const splitMutant = await importMutant(splitMutantSource);
  assert.notDeepEqual(splitMutant.splitTranslationText('hello world', 7), ['hello ', 'world'],
    '隔离移除自然断点后同一测试反例会切开 world');

  const quotaPrecheckMutantSource = sourceBefore.replace(
    'return cache.usage.characters + characters <= dailyLimit;',
    'return true;',
  );
  assert.notEqual(quotaPrecheckMutantSource, sourceBefore, '找到整帖额度预检分支');
  const quotaPrecheckMutant = await importMutant(quotaPrecheckMutantSource);
  const precheckMutantDir = await newDir('whole-post-quota-mutant');
  let precheckMutantCalls = 0;
  const precheckMutant = quotaPrecheckMutant.createAutoTranslator({
    dataDir: precheckMutantDir, now: () => quotaNow, dailyLimit: 500,
    fetchImpl: async () => { precheckMutantCalls++; return response('译文'); }, log: quiet,
  });
  await precheckMutant.initialize([]);
  await precheckMutant.enqueue([longPost]);
  assert.equal(precheckMutantCalls, 1, '隔离移除整帖预检后首块会消耗配额并请求');

  console.log('✓ 自动翻译选帖、baseline、分块、持久缓存/限额、并发去重、失败回退及隔离变异证明通过');
} finally {
  await rm(root, { recursive: true, force: true });
}
