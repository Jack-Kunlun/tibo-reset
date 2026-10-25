/** 公共 PC 手动更正接口。匿名写入是产品决策；Origin 校验只阻止浏览器跨站代写。 */

import { canonicalizeManualEntryTarget, projectManualData, validateManualEntry } from '../src/lib/manual-state.mjs';
import { analyzeTweet, detectSignals, latestEventMs } from '../src/lib/signals.mjs';
import { buildResetCalendar } from '../src/lib/reset-calendar.mjs';

const MAX_BODY_BYTES = 32 * 1024;
const BODY_KEYS = new Set(['revision', 'action', 'entry', 'entryId', 'id']);

function sendResponse(send, res, req, status, body) {
  const origin = req.headers?.origin;
  const headers = {
    'cache-control': 'no-store',
    vary: 'Origin',
    ...(origin ? { 'access-control-allow-origin': origin } : {}),
  };
  if (send) return send(res, status, body, headers);
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  return res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`);
      error.status = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sameOriginHost(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  const requestHost = req.headers?.host;
  if (!requestHost || origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password &&
      parsed.host.toLowerCase() === String(requestHost).toLowerCase() &&
      parsed.pathname === '/' && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function statusError(message, status = 422, code = 'MANUAL_INVALID') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function statusId(url, account) {
  if (typeof url !== 'string') return null;
  const match = /^https:\/\/x\.com\/([^/]+)\/status\/(\d+)$/.exec(url);
  return match && match[1].toLowerCase() === String(account).toLowerCase() ? match[2] : null;
}

function recordIds(record, account) {
  const ids = new Set();
  if (/^\d+$/.test(String(record?.id ?? ''))) ids.add(String(record.id));
  for (const url of [record?.url, ...(Array.isArray(record?.confirmation_urls) ? record.confirmation_urls : [])]) {
    const id = statusId(url, account);
    if (id) ids.add(id);
  }
  return ids;
}

const MANUAL_TWEET_STATUSES = new Set(['announced', 'landed', 'ignored']);

function evidenceTweetIds(items) {
  const ids = new Set();
  for (const item of items ?? []) {
    for (const evidence of item?.evidence ?? []) {
      if (evidence?.id != null) ids.add(String(evidence.id));
    }
  }
  return ids;
}

function activeManualEntryByTweet(manual, raw, account) {
  const entries = [...(manual?.entries ?? [])].sort((a, b) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || String(a.id).localeCompare(String(b.id)));
  const byTweet = new Map();
  for (const entry of entries) {
    if (!MANUAL_TWEET_STATUSES.has(entry.status)) continue;
    const target = canonicalizeManualEntryTarget(entry, { resets: raw.resets, tweets: raw.tweets, account });
    const ids = target.groupTweetIds.length
      ? target.groupTweetIds
      : target.entry.tweetId ? [String(target.entry.tweetId)] : [];
    for (const id of ids) if (!byTweet.has(String(id))) byTweet.set(String(id), entry);
  }
  return byTweet;
}

function landedTweetIds(records, raw, account) {
  const rawIds = new Set((raw.tweets?.tweets ?? []).map((tweet) => String(tweet.id)));
  const occurredAtById = new Map();
  for (const record of records ?? []) {
    const rawOccurrence = record?.first_confirmed_at ?? record?.occurred_at ?? record?.announced_at;
    const occurrenceMs = Date.parse(rawOccurrence ?? '');
    const occurredAt = Number.isFinite(occurrenceMs) ? new Date(occurrenceMs).toISOString() : null;
    for (const sourceId of recordIds(record, account)) {
      if (rawIds.has(sourceId)) recordOccurrence(sourceId, occurredAt, occurredAtById);
      const target = canonicalizeManualEntryTarget({ tweetId: sourceId }, {
        resets: raw.resets, tweets: raw.tweets, account,
      });
      for (const groupId of target.groupTweetIds) recordOccurrence(String(groupId), occurredAt, occurredAtById);
    }
  }
  return occurredAtById;
}

function recordOccurrence(tweetId, occurredAt, occurredAtById) {
  if (!occurredAt) {
    if (!occurredAtById.has(tweetId)) occurredAtById.set(tweetId, null);
    return;
  }
  const previous = Date.parse(occurredAtById.get(tweetId) ?? '');
  if (!Number.isFinite(previous) || Date.parse(occurredAt) < previous) occurredAtById.set(tweetId, occurredAt);
}

function statusLabel(status, source, detail = '') {
  if (status === 'announced') return detail || (source === 'manual' ? '手动预告' : '预告待落地');
  if (status === 'landed') return source === 'manual' ? '手动标记已到账' : '已到账';
  if (status === 'ignored') return '已忽略';
  if (status === 'hint') return '线索';
  return detail || '普通动态';
}

function buildTweetStates({ raw, effective, manual, signals, account, now }) {
  const rawTweets = Array.isArray(raw.tweets?.tweets) ? raw.tweets.tweets : [];
  const effectiveTweets = Array.isArray(effective.tweets?.tweets) ? effective.tweets.tweets : [];
  const effectiveById = new Map(effectiveTweets.map((tweet) => [String(tweet.id), tweet]));
  const manualByTweet = activeManualEntryByTweet(manual, raw, account);
  const landedIds = landedTweetIds(effective.resets?.records, raw, account);
  const currentForecastIds = evidenceTweetIds(signals?.forecasts);
  const overdueForecastIds = evidenceTweetIds(signals?.overdueForecasts);
  const activeHintIds = new Set((signals?.activeHints ?? []).map((hint) => String(hint.id)));
  const result = {};

  for (const rawTweet of rawTweets) {
    const id = String(rawTweet.id);
    const tweet = effectiveById.get(id) ?? rawTweet;
    const decision = tweet.manualDecision;
    const ledgerEntry = manualByTweet.get(id);
    const manualStatus = MANUAL_TWEET_STATUSES.has(decision?.status)
      ? decision.status
      : MANUAL_TWEET_STATUSES.has(ledgerEntry?.status) ? ledgerEntry.status : null;
    if (manualStatus) {
      result[id] = {
        status: manualStatus,
        label: statusLabel(manualStatus, 'manual'),
        source: 'manual',
        ...(ledgerEntry?.id ? { entryId: ledgerEntry.id } : {}),
        ...((decision?.note ?? ledgerEntry?.note) ? { note: decision?.note ?? ledgerEntry.note } : {}),
        ...(manualStatus === 'landed' && (decision?.occurredAt ?? ledgerEntry?.occurredAt ?? landedIds.get(id))
          ? { occurredAt: decision?.occurredAt ?? ledgerEntry?.occurredAt ?? landedIds.get(id) } : {}),
      };
      continue;
    }

    if (landedIds.has(id)) {
      result[id] = {
        status: 'landed', label: statusLabel('landed', 'automatic'), source: 'automatic',
        ...(landedIds.get(id) ? { occurredAt: landedIds.get(id) } : {}),
      };
      continue;
    }
    if (currentForecastIds.has(id)) {
      result[id] = { status: 'announced', label: statusLabel('announced', 'automatic'), source: 'automatic' };
      continue;
    }
    if (overdueForecastIds.has(id)) {
      result[id] = { status: 'announced', label: statusLabel('announced', 'automatic', '预告已过期，待核实'), source: 'automatic' };
      continue;
    }
    if (activeHintIds.has(id)) {
      result[id] = { status: 'hint', label: statusLabel('hint', 'automatic'), source: 'automatic' };
      continue;
    }

    const analysis = analyzeTweet(tweet, { account, tweets: effectiveTweets, now });
    const detail = analysis.level === 'occurred'
      ? '提及重置，待确认'
      : analysis.level === 'explicit'
        ? '历史预告，非当前预告'
        : analysis.level === 'hint' ? '历史线索，非当前线索' : '普通动态';
    result[id] = { status: 'none', label: detail, source: 'automatic' };
  }
  return result;
}

function normalizeEffectiveTarget(entry, effectiveRecords, manualState) {
  if (!entry.recordId) return entry;
  const record = effectiveRecords.find((item) => String(item.id) === entry.recordId);
  if (!record || /^\d+$/.test(entry.recordId)) return entry;

  if (record.manualAccountObservation === true) {
    const match = /^manual-account-(\d+)$/.exec(entry.recordId);
    if (!match) throw statusError('合成到账记录缺少有效的原推文 ID');
    if (entry.tweetId && entry.tweetId !== match[1]) throw statusError('recordId 与 tweetId 并非同一来源');
    const { recordId, ...rest } = entry;
    return { ...rest, tweetId: match[1] };
  }

  if (!record.manualEntryId) return entry;

  const sourceEntryId = record.manualEntryId;
  const sourceEntry = manualState.entries.find((item) => item.id === sourceEntryId);
  if (!sourceEntry || record.id !== `manual-${sourceEntry.id}`) {
    throw statusError('合成到账记录没有可编辑的账本来源');
  }
  if (entry.id && entry.id !== sourceEntry.id) throw statusError('recordId 已属于另一条手动更正');
  if (entry.tweetId && sourceEntry.tweetId && entry.tweetId !== sourceEntry.tweetId) {
    throw statusError('recordId 与 tweetId 并非同一来源');
  }
  if (entry.recordId && sourceEntry.recordId && entry.recordId !== sourceEntry.recordId &&
      entry.recordId !== `manual-${sourceEntry.id}`) {
    throw statusError('recordId 与原手动更正目标不一致');
  }
  const { recordId, ...rest } = entry;
  return {
    ...rest,
    id: entry.id ?? sourceEntry.id,
    ...(sourceEntry.tweetId ? { tweetId: entry.tweetId ?? sourceEntry.tweetId } : {}),
    ...(sourceEntry.recordId ? { recordId: sourceEntry.recordId } : {}),
  };
}

function validateTarget(entry, raw, account) {
  const tweets = Array.isArray(raw.tweets?.tweets) ? raw.tweets.tweets : [];
  const records = Array.isArray(raw.resets?.records) ? raw.resets.records : [];
  const tweet = entry.tweetId ? tweets.find((item) => String(item.id) === entry.tweetId) : null;
  const record = entry.recordId ? records.find((item) => String(item.id) === entry.recordId) : null;
  if (entry.tweetId && !tweet) throw statusError('tweetId 不存在于当前采集数据');
  if (entry.recordId && !record) throw statusError('recordId 不存在于当前重置记录');
  if (entry.tweetId && entry.recordId) {
    const linked = String(record.id) === entry.tweetId || recordIds(record, account).has(entry.tweetId) ||
      statusId(tweet.url, account) !== null && recordIds(record, account).has(statusId(tweet.url, account));
    if (!linked) throw statusError('tweetId 与 recordId 并非同一来源');
  }

  let publishedTweet = tweet;
  if (!publishedTweet && record) {
    const ids = recordIds(record, account);
    publishedTweet = tweets.find((item) => ids.has(String(item.id)) || ids.has(statusId(item.url, account)));
  }
  if (entry.occurredAt && publishedTweet) {
    const publishedAt = Date.parse(publishedTweet.created_at);
    if (Number.isFinite(publishedAt) && publishedAt > Date.parse(entry.occurredAt)) {
      throw statusError('occurredAt 不能早于关联原帖发布时间');
    }
  }
}

function bodyKeysValid(body) {
  return body && typeof body === 'object' && !Array.isArray(body) &&
    Object.keys(body).every((key) => BODY_KEYS.has(key));
}

function rawFromStore(store) {
  if (typeof store?.getRawData === 'function') return store.getRawData();
  return Promise.all([store.getResets(), store.getTweets(), store.getStats()]).then(([resets, tweets, statsFile]) => ({ resets, tweets, statsFile }));
}

function resolveSignals(currentState, effective, now, account) {
  const supplied = currentState?.signals ?? (currentState &&
    ('forecasts' in currentState || 'overdueForecasts' in currentState || 'activeHints' in currentState)
    ? currentState : null);
  return supplied ?? detectSignals(effective.tweets.tweets, {
    now,
    account,
    lastResetAt: latestEventMs(effective.resets.records),
  });
}

function selectableProgramPlan(effective, signals, now, account) {
  const calendar = buildResetCalendar({
    records: effective.resets.records,
    tweets: effective.tweets.tweets,
    signals,
    now,
    account,
  });
  const plan = calendar?.plan;
  if (!plan?.programId || !Number.isInteger(plan.days) || !Array.isArray(plan.rows) ||
      !plan.toDate || now > Date.parse(`${plan.toDate}T23:59:59.999Z`)) return null;
  return {
    programId: String(plan.programId),
    days: plan.days,
    latestDay: plan.latestDay,
    rows: plan.rows.map(({ day, status, statusLabel }) => ({ day, status, statusLabel })),
  };
}

function hasValidatedProgramHistory(entry, manualState) {
  const previous = manualState.entries.find((item) => item.id === entry.id);
  if (!previous || previous.status !== 'landed' || previous.programId !== entry.programId ||
      previous.programDay !== entry.programDay) return false;
  return manualState.history.some((item) => item.action === 'save' && item.entryId === previous.id &&
    item.after?.status === 'landed' && item.after.programId === previous.programId &&
    item.after.programDay === previous.programDay);
}

function validateProgramAssignment(entry, canonical, effective, signals, now, account, manualState) {
  if (!entry.programId) return;
  const plan = selectableProgramPlan(effective, signals, now, account);
  const isCurrentProgram = Boolean(plan && String(entry.programId) === plan.programId);
  if (isCurrentProgram) {
    if (entry.programDay > plan.days || !plan.rows.some((row) => row.day === entry.programDay)) {
      throw statusError('programDay 超出当前每日计划');
    }
  } else if (!hasValidatedProgramHistory(entry, manualState)) {
    if (!plan) throw statusError('当前没有可归属的每日计划，或该计划已结束');
    throw statusError('programId 不属于当前可信每日计划');
  }
  const ids = new Set(canonical.groupTweetIds.map(String));
  if (canonical.entry.tweetId) ids.add(String(canonical.entry.tweetId));
  const rawTweets = Array.isArray(effective.tweets?.tweets) ? effective.tweets.tweets : [];
  const explicitDays = rawTweets.filter((tweet) => ids.has(String(tweet.id)))
    .map((tweet) => String(tweet.text ?? '').match(/\bDay\s*(\d+)(?:\.\d+|\s*\([^)]*\))?\s*\//i))
    .filter(Boolean).map((match) => Number(match[1]));
  if (explicitDays.some((day) => day !== entry.programDay)) {
    throw statusError('关联推文已声明不同的 Day 编号，不能归属到所选日程');
  }
}

function manualStoreFrom(store) {
  if (store?.manualStore) return store.manualStore;
  if (typeof store?.getManualState === 'function' && typeof store?.mutateManual === 'function') {
    return { get: store.getManualState, mutate: store.mutateManual };
  }
  throw new Error('管理接口缺少 manualStore');
}

/** GET 返回公开可审查的原始推文与有效记录；POST 保存或撤销一条账本更正。 */
export async function handleManage(req, res, { store, send, account = 'thsottiaux', getState, onSaved, now = Date.now() } = {}) {
  const reply = (status, body) => sendResponse(send, res, req, status, body);
  if (req.method !== 'GET' && req.method !== 'POST') return reply(405, { error: 'method not allowed' });
  if (req.method === 'POST' && !sameOriginHost(req)) return reply(403, { error: 'cross-origin write rejected' });

  const manualStore = manualStoreFrom(store);
  if (req.method === 'GET') {
    const [raw, manual, currentState] = await Promise.all([
      rawFromStore(store),
      manualStore.get(),
      typeof getState === 'function' ? getState() : null,
    ]);
    const currentNow = typeof now === 'function' ? now() : now;
    const effective = projectManualData({ ...raw, manual, now: currentNow, account });
    const signals = resolveSignals(currentState, effective, currentNow, account);
    return reply(200, {
      revision: manual.revision,
      dataUpdatedAt: raw.tweets?.updated_at ?? null,
      forecasts: signals?.forecasts ?? [],
      overdueForecasts: signals?.overdueForecasts ?? [],
      records: effective.resets.records,
      tweets: raw.tweets?.tweets ?? [],
      tweetStates: buildTweetStates({ raw, effective, manual, signals, account, now: currentNow }),
      programPlan: selectableProgramPlan(effective, signals, currentNow, account),
      entries: manual.entries,
      history: manual.history,
    });
  }

  const contentType = String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return reply(415, { error: 'content-type must be application/json' });
  let text;
  try { text = await readBody(req); }
  catch (error) { return reply(error.status ?? 400, { error: error.message }); }
  let body;
  try { body = JSON.parse(text); }
  catch { return reply(400, { error: 'invalid json' }); }
  if (!bodyKeysValid(body)) return reply(422, { error: 'invalid request shape' });
  if (!Number.isSafeInteger(body.revision) || body.revision < 0) return reply(422, { error: 'revision must be a non-negative integer' });

  const raw = await rawFromStore(store);
  const currentNow = typeof now === 'function' ? now() : now;
  if (body.action === 'save') {
    if (!body.entry || body.entryId !== undefined || body.id !== undefined) return reply(422, { error: 'save requires entry only' });
    let entry;
    try { entry = validateManualEntry(body.entry, { now: currentNow, account }); }
    catch (error) { return reply(error.status ?? 422, { error: error.message }); }
    try {
      const manual = await manualStore.get();
      const effective = projectManualData({ ...raw, manual, now: currentNow, account });
      const effectiveRecords = effective.resets.records;
      entry = normalizeEffectiveTarget(entry, effectiveRecords, manual);
      entry = validateManualEntry(entry, { now: currentNow, account });
      validateTarget(entry, raw, account);
      const canonical = canonicalizeManualEntryTarget(entry, { resets: raw.resets, tweets: raw.tweets, account });
      entry = canonical.entry;
      const currentState = typeof getState === 'function' ? await getState() : null;
      const signals = resolveSignals(currentState, effective, currentNow, account);
      validateProgramAssignment(entry, canonical, effective, signals, currentNow, account, manual);
      if (entry.programId && manual.entries.some((existing) => existing.id !== entry.id &&
          existing.programId === entry.programId && existing.programDay === entry.programDay)) {
        throw statusError('这个活动日已关联一条手动到账记录', 409, 'MANUAL_PROGRAM_DAY_EXISTS');
      }
      if (canonical.groupTweetIds.length) {
        const groupIds = new Set(canonical.groupTweetIds);
        const overlapping = manual.entries.filter((existing) => {
          const target = canonicalizeManualEntryTarget(existing, { resets: raw.resets, tweets: raw.tweets, account });
          return target.groupTweetIds.some((id) => groupIds.has(id));
        });
        if (overlapping.length > 1) {
          throw statusError('同一 verified 会话已有多条手动更正，请先撤销冲突项', 409, 'MANUAL_GROUP_CONFLICT');
        }
        if (overlapping.length === 1) {
          const existingId = overlapping[0].id;
          const explicitId = manual.entries.find((item) => item.id === entry.id);
          if (explicitId && explicitId.id !== existingId) {
            throw statusError('提交的 entry.id 与该会话现有更正不一致', 409, 'MANUAL_GROUP_CONFLICT');
          }
          entry = { ...entry, id: existingId };
        }
      }
    }
    catch (error) { return reply(error.status ?? 422, { error: error.message }); }
    try {
      const result = await manualStore.mutate({ revision: body.revision, action: 'save', entry, now: currentNow, account });
      let notification;
      if (result.entry.status === 'landed' && typeof onSaved === 'function') {
        // 编辑归属或备注仍可重试原待发队列，但不能把编辑时刻变成一次新的到账确认。
        const confirmations = result.history.filter((item) => item.action === 'save' && item.entryId === result.entry.id &&
          item.after?.status === 'landed' && item.before?.status !== 'landed').map((item) => Date.parse(item.at)).filter(Number.isFinite);
        const confirmedAt = confirmations.length ? new Date(Math.min(...confirmations)).toISOString() : result.entry.createdAt;
        const change = result.history.at(-1);
        const newConfirmation = change?.entryId === result.entry.id && change.before?.status !== 'landed';
        try { notification = await onSaved({ entry: result.entry, manualEntryId: result.entry.id, confirmedAt, newConfirmation }); }
        catch (error) { notification = { sent: 0, failed: 1, error: String(error?.message ?? 'notification failed') }; }
      }
      return reply(200, { revision: result.revision, entry: result.entry, entries: result.entries, history: result.history,
        ...(notification !== undefined ? { notification } : {}) });
    } catch (error) {
      return reply(error.status ?? 500, { error: error.message, ...(error.code === 'REVISION_CONFLICT' ? { revision: (await manualStore.get()).revision } : {}) });
    }
  }

  if (body.action === 'withdraw') {
    if (body.entry !== undefined || (body.entryId !== undefined && body.id !== undefined && body.entryId !== body.id)) {
      return reply(422, { error: 'withdraw accepts one id' });
    }
    const entryId = body.entryId ?? body.id;
    try {
      const result = await manualStore.mutate({ revision: body.revision, action: 'withdraw', entryId, now: currentNow, account });
      return reply(200, { revision: result.revision, entryId: result.entryId, entries: result.entries, history: result.history });
    } catch (error) {
      return reply(error.status ?? 500, { error: error.message, ...(error.code === 'REVISION_CONFLICT' ? { revision: (await manualStore.get()).revision } : {}) });
    }
  }
  return reply(422, { error: 'action must be save or withdraw' });
}
