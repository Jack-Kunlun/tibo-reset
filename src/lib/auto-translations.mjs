import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { translationFor } from './tweet-translations.mjs';

export const TRANSLATION_CACHE_FILE = 'translation-cache.json';

const DAY_MS = 24 * 60 * 60_000;
const TRUSTED_SOURCES = new Set(['timeline-browser', 'with-replies']);

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function objectRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedAccount(value) {
  return String(value ?? '').replace(/^@/, '').toLowerCase();
}

function tweetId(tweet) {
  const id = String(tweet?.id ?? '');
  return /^\d+$/.test(id) ? id : null;
}

function isTrustedTweet(tweet, account) {
  return Boolean(tweet) && tweet.manual !== true &&
    tweet.foundVia !== 'manual' && normalizedAccount(tweet.account) !== 'manual' &&
    tweet.author_verified === true && normalizedAccount(tweet.account) === normalizedAccount(account) &&
    TRUSTED_SOURCES.has(tweet.foundVia) && tweetId(tweet) !== null && typeof tweet.text === 'string';
}

function addEvidenceIds(target, list) {
  for (const item of list ?? []) {
    if (item?.id != null && /^\d+$/.test(String(item.id))) target.add(String(item.id));
    for (const evidence of item?.evidence ?? []) {
      if (evidence?.id != null && /^\d+$/.test(String(evidence.id))) target.add(String(evidence.id));
    }
  }
}

function occurredWithinDay(item, anchor) {
  const time = Date.parse(item?.occurredAt ?? item?.createdAt ?? item?.created_at ?? '');
  return Number.isFinite(time) && time <= anchor && anchor - time <= DAY_MS;
}

/** 只为当前计划或近期重置证据补译，普通动态和仅表达愿望的线索不入队。 */
export function selectTranslationTweets(tweets, signals, { account = 'thsottiaux' } = {}) {
  const relevant = new Set();
  for (const row of signals?.calendar?.plan?.rows ?? []) {
    for (const entry of row?.entries ?? []) {
      if (entry?.id != null && /^\d+$/.test(String(entry.id))) relevant.add(String(entry.id));
    }
  }
  addEvidenceIds(relevant, signals?.forecasts);
  addEvidenceIds(relevant, signals?.overdueForecasts);
  addEvidenceIds(relevant, signals?.observedForecasts);
  for (const observation of signals?.accountObservations ?? []) {
    if (observation?.announcementId != null && /^\d+$/.test(String(observation.announcementId))) {
      relevant.add(String(observation.announcementId));
    }
  }

  const anchor = Date.parse(signals?.generatedAt ?? '');
  const recentOccurred = Number.isFinite(anchor)
    ? new Set((signals?.occurred ?? []).filter((item) => occurredWithinDay(item, anchor))
      .map((item) => String(item.id)).filter((id) => /^\d+$/.test(id)))
    : new Set();
  for (const id of recentOccurred) relevant.add(id);

  return (tweets ?? []).filter((tweet) => isTrustedTweet(tweet, account) && relevant.has(String(tweet.id)));
}

function isPreferredBoundary(point) {
  return /\s/.test(point) || /[.!?。！？;；:：]/.test(point);
}

/** 优先按空白或句末断开；没有自然边界时才按 Unicode 码点切分。 */
export function splitTranslationText(text, maxBytes = 500) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes 必须是正整数');
  const value = String(text ?? '');
  const points = [...value];
  const chunks = [];
  let start = 0;
  while (start < points.length) {
    let end = start;
    let bytes = 0;
    while (end < points.length) {
      const pointBytes = Buffer.byteLength(points[end], 'utf8');
      if (pointBytes > maxBytes) throw new RangeError('maxBytes 小于单个 Unicode 码点的 UTF-8 长度');
      if (bytes + pointBytes > maxBytes) break;
      bytes += pointBytes;
      end++;
    }
    if (end === points.length) {
      chunks.push(points.slice(start).join(''));
      break;
    }
    let preferredEnd = end;
    for (let boundary = start + 1; boundary <= end; boundary++) {
      if (isPreferredBoundary(points[boundary - 1])) preferredEnd = boundary;
    }
    chunks.push(points.slice(start, preferredEnd).join(''));
    start = preferredEnd;
  }
  return chunks;
}

function utcDate(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validUtcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && utcDate(timestamp) === value;
}

export function validTranslationCache(cache) {
  if (!objectRecord(cache) || cache.schema !== 1 || !Number.isSafeInteger(cache.revision) || cache.revision < 0 ||
      !objectRecord(cache.baseline) || !objectRecord(cache.entries) || !objectRecord(cache.attempts) ||
      !objectRecord(cache.usage) || !validUtcDate(cache.usage.date) ||
      !Number.isSafeInteger(cache.usage.characters) || cache.usage.characters < 0 ||
      (cache.blockedUntil !== undefined && !validTimestamp(cache.blockedUntil))) return false;
  if (!Object.values(cache.baseline).every(isSha256)) return false;
  if (!Object.entries(cache.entries).every(([id, entry]) => /^\d+$/.test(id) && objectRecord(entry) &&
      isSha256(entry.sourceHash) && typeof entry.text === 'string' && entry.text.trim().length > 0 &&
      entry.text.length <= 20_000 && entry.language === 'zh-CN' && entry.provider === 'mymemory' &&
      validTimestamp(entry.translatedAt))) return false;
  return Object.entries(cache.attempts).every(([id, attempt]) => /^\d+$/.test(id) && objectRecord(attempt) &&
    isSha256(attempt.sourceHash) && validTimestamp(attempt.retryAfter));
}

function newCache(tweets, now) {
  const baseline = Object.create(null);
  for (const tweet of tweets ?? []) {
    const id = String(tweet?.id ?? '');
    if (id && typeof tweet.text === 'string') baseline[id] = sha256(tweet.text);
  }
  return {
    schema: 1,
    revision: 0,
    baseline,
    entries: Object.create(null),
    usage: { date: utcDate(now), characters: 0 },
    attempts: Object.create(null),
  };
}

function decodeEntities(value) {
  return String(value).replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (match, token) => {
    const lower = token.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos' || lower === '#39') return "'";
    if (lower === 'nbsp') return ' ';
    const codepoint = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    try { return Number.isInteger(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : match; }
    catch { return match; }
  });
}

function plainTranslation(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /<(?:!doctype|html|head|body|script|style|title)\b/i.test(raw)) return '';
  return decodeEntities(raw.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
}

function conciseLog(log, message) {
  try {
    if (typeof log === 'function') log(message);
    else if (typeof log?.warn === 'function') log.warn(message);
  } catch { /* 日志失败不能中断回退到英文原文。 */ }
}

function hasQuotaWarning(payload, bodyText) {
  const responseText = payload?.responseData?.translatedText ?? '';
  const details = `${payload?.responseDetails ?? ''} ${payload?.quotaFinished ?? ''} ${bodyText ?? ''} ${responseText}`;
  return payload?.quotaFinished === true || Number(payload?.responseStatus) === 429 ||
    /used all available free translations|quota(?:\s|_)*(?:exceeded|finished|limit)|daily translation limit|rate limit|too many requests/i.test(details);
}

function makeHttpUrl(text) {
  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', text);
  url.searchParams.set('langpair', 'en|zh-CN');
  url.searchParams.set('mt', '1');
  return url;
}

export function createAutoTranslator({
  dataDir,
  account = 'thsottiaux',
  fetchImpl = globalThis.fetch,
  now = Date.now,
  requestTimeoutMs = 5000,
  maxRunMs = 20_000,
  maxPostsPerRun = 5,
  dailyLimit = 4500,
  retryMs = 15 * 60_000,
  log = console,
} = {}) {
  if (!dataDir) throw new TypeError('dataDir 必须指定');
  const cachePath = resolve(dataDir, TRANSLATION_CACHE_FILE);
  let cache = null;
  let initialized = false;
  let unavailable = false;
  let workerPromise = null;
  const pending = new Map();

  function runtimeNow() {
    const value = typeof now === 'function' ? now() : now;
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new TypeError('now 必须返回有效时间');
    return timestamp;
  }

  async function saveCache() {
    if (!cache || unavailable) throw new Error('翻译缓存不可写');
    const temp = `${cachePath}.tmp-${randomUUID()}`;
    await mkdir(dirname(cachePath), { recursive: true });
    try {
      await writeFile(temp, `${JSON.stringify(cache, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temp, cachePath);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      unavailable = true;
      throw error;
    }
  }

  async function initialize(tweets) {
    if (initialized) return;
    let raw;
    try {
      raw = await readFile(cachePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      cache = newCache(tweets, runtimeNow());
      await saveCache();
      initialized = true;
      return;
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { unavailable = true; throw new Error('翻译缓存 JSON 损坏，已保留文件'); }
    if (!validTranslationCache(parsed)) {
      unavailable = true;
      throw new Error('翻译缓存结构无效，已保留文件');
    }
    cache = parsed;
    initialized = true;
  }

  function appendPending(tweets) {
    for (const tweet of tweets ?? []) {
      if (!isTrustedTweet(tweet, account)) continue;
      const id = String(tweet.id);
      // 同一条待处理推文保留最新全文，以免旧入队项覆盖随后到来的编辑。
      pending.set(id, { ...tweet, id });
    }
  }

  async function persistAttempt(id, sourceHash, timestamp) {
    cache.attempts[id] = { sourceHash, retryAfter: new Date(timestamp).toISOString() };
    await saveCache();
  }

  async function reserveCharacters(characters, timestamp) {
    const date = utcDate(timestamp);
    if (cache.usage.date !== date) cache.usage = { date, characters: 0 };
    if (cache.usage.characters + characters > dailyLimit) {
      await saveCache();
      return false;
    }
    cache.usage.characters += characters;
    await saveCache();
    return true;
  }

  async function canReserveWholePost(characters, timestamp) {
    const date = utcDate(timestamp);
    if (cache.usage.date !== date) {
      cache.usage = { date, characters: 0 };
      await saveCache();
    }
    return cache.usage.characters + characters <= dailyLimit;
  }

  async function callMyMemory(query, timeoutMs) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch 不可用');
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('翻译请求超时'), { code: 'TRANSLATION_TIMEOUT' }));
        }, Math.max(1, timeoutMs));
      });
      const request = Promise.resolve().then(async () => {
        const response = await fetchImpl(makeHttpUrl(query), { method: 'GET', signal: controller.signal });
        let payload = null;
        try { payload = await response.json(); } catch { /* 下方按无效响应处理。 */ }
        const bodyText = typeof payload?.responseData?.translatedText === 'string'
          ? payload.responseData.translatedText : '';
        if (Number(response?.status) === 429 || hasQuotaWarning(payload, bodyText)) {
          const error = new Error('MyMemory 免费翻译额度暂不可用');
          error.code = 'TRANSLATION_QUOTA';
          throw error;
        }
        if (Number(response?.status) !== 200 || Number(payload?.responseStatus) !== 200) {
          throw new Error('MyMemory 返回非成功状态');
        }
        if (/^\s*MYMEMORY\s+(?:WARNING|ERROR)\s*:/i.test(bodyText)) {
          throw new Error('MyMemory 返回服务提示，保留英文原文');
        }
        const text = plainTranslation(bodyText);
        if (!text) throw new Error('MyMemory 返回空译文或错误页面');
        return text;
      });
      return await Promise.race([request, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function translateOne(tweet, startedAt, counts) {
    const id = String(tweet.id);
    const sourceHash = sha256(tweet.text);
    if (cache.baseline[id] === sourceHash) return;
    if (translationFor(tweet, cache.entries)) return;
    const timestamp = runtimeNow();
    if (Date.parse(cache.blockedUntil ?? '') > timestamp) return;
    const previousAttempt = cache.attempts[id];
    if (previousAttempt?.sourceHash === sourceHash && Date.parse(previousAttempt.retryAfter) > timestamp) return;
    if (previousAttempt && previousAttempt.sourceHash !== sourceHash) delete cache.attempts[id];

    const chunks = splitTranslationText(tweet.text, 500);
    if (!chunks.length) return;
    const totalCharacters = Array.from(tweet.text).length;
    if (!await canReserveWholePost(totalCharacters, timestamp)) return;
    const translatedChunks = [];
    let requested = false;
    let postCounted = false;
    try {
      for (const chunk of chunks) {
        const elapsed = runtimeNow() - startedAt;
        const remaining = maxRunMs - elapsed;
        if (remaining <= 0) {
          if (requested) await persistAttempt(id, sourceHash, runtimeNow() + retryMs);
          return;
        }
        const characters = Array.from(chunk).length;
        const currentTime = runtimeNow();
        if (!await reserveCharacters(characters, currentTime)) return;
        const requestRemaining = maxRunMs - (runtimeNow() - startedAt);
        if (requestRemaining <= 0) {
          if (requested) await persistAttempt(id, sourceHash, runtimeNow() + retryMs);
          return;
        }
        requested = true;
        if (!postCounted) {
          counts.posts++;
          postCounted = true;
        }
        const timeoutMs = Math.min(requestTimeoutMs, requestRemaining);
        translatedChunks.push(await callMyMemory(chunk, timeoutMs));
      }
    } catch (error) {
      const failedAt = runtimeNow();
      if (error?.code === 'TRANSLATION_QUOTA') {
        cache.blockedUntil = new Date(failedAt + DAY_MS).toISOString();
        await saveCache();
        conciseLog(log, '[translation] MyMemory 达到额度上限，24 小时内保留英文原文');
      } else {
        if (requested) await persistAttempt(id, sourceHash, failedAt + retryMs);
        conciseLog(log, `[translation] 推文 ${id} 暂未翻译，保留英文原文`);
      }
      return;
    }

    const translatedText = translatedChunks.join('');
    if (!translatedText.trim()) {
      if (requested) await persistAttempt(id, sourceHash, runtimeNow() + retryMs);
      return;
    }
    if (translatedText.length > 20_000) {
      if (requested) await persistAttempt(id, sourceHash, runtimeNow() + retryMs);
      conciseLog(log, `[translation] 推文 ${id} 译文超过缓存长度限制，保留英文原文`);
      return;
    }
    const old = cache.entries[id];
    const changed = !old || old.sourceHash !== sourceHash || old.text !== translatedText ||
      old.language !== 'zh-CN' || old.provider !== 'mymemory';
    cache.entries[id] = {
      sourceHash,
      text: translatedText,
      language: 'zh-CN',
      provider: 'mymemory',
      translatedAt: new Date(runtimeNow()).toISOString(),
    };
    delete cache.attempts[id];
    if (changed) cache.revision++;
    await saveCache();
  }

  async function runWorker() {
    if (!initialized) throw new Error('翻译器尚未 initialize');
    if (unavailable) return;
    const startedAt = runtimeNow();
    const counts = { posts: 0 };
    while (pending.size && counts.posts < maxPostsPerRun && runtimeNow() - startedAt < maxRunMs) {
      const [id, tweet] = pending.entries().next().value;
      pending.delete(id);
      await translateOne(tweet, startedAt, counts);
      if (unavailable) break;
    }
  }

  function enqueue(selectedTweets) {
    if (!initialized || unavailable) return Promise.resolve();
    appendPending(selectedTweets);
    if (!workerPromise) {
      workerPromise = runWorker().catch((error) => {
        unavailable = true;
        conciseLog(log, `[translation] 缓存或处理失败，保留英文原文：${error.message}`);
      }).finally(() => { workerPromise = null; });
    }
    return workerPromise;
  }

  async function idle() {
    while (workerPromise) await workerPromise;
  }

  return { initialize, enqueue, idle };
}
