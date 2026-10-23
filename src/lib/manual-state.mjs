/**
 * 手动更正的独立账本与有效数据投影。
 * 采集器只拥有原始重置、推文和统计文件；这份账本单独原子写入，避免下一轮入库覆盖人工判断。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { buildStats } from './collect.mjs';
import { confirmedResetEvent, readAccountObservation } from './signals.mjs';

export const MANUAL_STATE_FILE = 'manual-state.json';
export const MAX_MANUAL_STATE_BYTES = 2 * 1024 * 1024;
export const MAX_MANUAL_ENTRIES = 1000;
export const MAX_MANUAL_HISTORY = 5000;

const DAY_MS = 24 * 60 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_ACCOUNT = 'thsottiaux';
const ENTRY_KEYS = new Set([
  'id', 'tweetId', 'recordId', 'status', 'title', 'note', 'sourceUrl',
  'occurredAt', 'windowFrom', 'windowTo', 'eventType', 'createdAt', 'updatedAt',
]);
const INPUT_ENTRY_KEYS = new Set([
  'id', 'tweetId', 'recordId', 'status', 'title', 'note', 'sourceUrl',
  'occurredAt', 'windowFrom', 'windowTo', 'eventType',
]);

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function manualError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function stateError(message) {
  return manualError('MANUAL_STATE_CORRUPT', message, 500);
}

function normalizeNow(now) {
  const at = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(at)) throw manualError('MANUAL_INVALID', 'now 不是有效时间');
  return at;
}

/** 只接受带 Z 或明确数值时区偏移的完整 ISO 日期时间。 */
export function parseExplicitOffset(value, field = '时间') {
  if (typeof value !== 'string') throw manualError('MANUAL_INVALID', `${field} 必须是带时区的 ISO 时间`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw manualError('MANUAL_INVALID', `${field} 必须包含 Z 或明确的 ±HH:MM 时区`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offset] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const monthEnd = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > monthEnd || hour > 23 || minute > 59 || second > 59) {
    throw manualError('MANUAL_INVALID', `${field} 不是有效日期时间`);
  }
  if (offset !== 'Z') {
    const [offsetHour, offsetMinute] = offset.slice(1).split(':').map(Number);
    if (offsetHour > 23 || offsetMinute > 59) throw manualError('MANUAL_INVALID', `${field} 时区偏移无效`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw manualError('MANUAL_INVALID', `${field} 不是有效时间`);
  return parsed;
}

function canonicalIso(value, field, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw manualError('MANUAL_INVALID', `${field} 缺失`);
  }
  return new Date(parseExplicitOffset(value, field)).toISOString();
}

function validateSourceUrl(value, account = DEFAULT_ACCOUNT) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw manualError('MANUAL_INVALID', 'sourceUrl 必须是规范的 X 原帖地址');
  const parsed = new URL(value);
  const expectedPath = new RegExp(`^/${String(account).toLowerCase()}/status/\\d+$`);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'x.com' || !expectedPath.test(parsed.pathname) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port || parsed.href !== value) {
    throw manualError('MANUAL_INVALID', 'sourceUrl 必须是无参数的规范 X 原帖地址');
  }
  return value;
}

/** 校验并规范化用户提交的账本条目。目标 ID 的存在性由管理接口按当前原始数据再校验。 */
export function validateManualEntry(value, { now = Date.now(), account = DEFAULT_ACCOUNT, stored = false } = {}) {
  if (!isObject(value)) throw manualError('MANUAL_INVALID', 'entry 必须是 JSON 对象');
  const allowed = stored ? ENTRY_KEYS : INPUT_ENTRY_KEYS;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw manualError('MANUAL_INVALID', `entry 包含不允许的字段：${key}`);
  }

  const id = value.id;
  if (id !== undefined && (typeof id !== 'string' || !UUID_RE.test(id))) {
    throw manualError('MANUAL_INVALID', 'entry.id 必须是 UUID');
  }
  const tweetId = value.tweetId === undefined || value.tweetId === null || value.tweetId === ''
    ? undefined : String(value.tweetId).trim();
  const recordId = value.recordId === undefined || value.recordId === null || value.recordId === ''
    ? undefined : String(value.recordId).trim();
  if (tweetId !== undefined && (!/^\d+$/.test(tweetId) || tweetId.length > 32)) {
    throw manualError('MANUAL_INVALID', 'tweetId 格式无效');
  }
  if (recordId !== undefined && (recordId.length > 160 || /[\u0000-\u001f]/.test(recordId))) {
    throw manualError('MANUAL_INVALID', 'recordId 格式无效');
  }

  if (!['announced', 'landed', 'ignored'].includes(value.status)) {
    throw manualError('MANUAL_INVALID', 'status 必须是 announced、landed 或 ignored');
  }
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > 500) {
    throw manualError('MANUAL_INVALID', 'title 必须是 1–500 字符');
  }
  const note = value.note === undefined ? '' : value.note;
  if (typeof note !== 'string' || note.length > 2000) throw manualError('MANUAL_INVALID', 'note 最长 2000 字符');
  const eventType = value.eventType === undefined ? 'reset' : value.eventType;
  if (!['reset', 'credit'].includes(eventType)) throw manualError('MANUAL_INVALID', 'eventType 必须是 reset 或 credit');
  const sourceUrl = validateSourceUrl(value.sourceUrl, account);
  const occurredAt = canonicalIso(value.occurredAt, 'occurredAt', { optional: true });
  const windowFrom = canonicalIso(value.windowFrom, 'windowFrom', { optional: true });
  const windowTo = canonicalIso(value.windowTo, 'windowTo', { optional: true });
  if (Boolean(windowFrom) !== Boolean(windowTo)) throw manualError('MANUAL_INVALID', 'windowFrom 与 windowTo 必须同时填写');

  const nowMs = normalizeNow(now);
  if (occurredAt) {
    if (Date.parse(occurredAt) > nowMs) throw manualError('MANUAL_INVALID', 'occurredAt 不能晚于当前时间');
  }
  if (value.status === 'landed' && !occurredAt) throw manualError('MANUAL_INVALID', 'landed 状态必须填写 occurredAt');
  if (value.status === 'announced' && occurredAt) throw manualError('MANUAL_INVALID', 'announced 状态不能填写 occurredAt');
  if (windowFrom && windowTo) {
    const from = Date.parse(windowFrom), to = Date.parse(windowTo);
    if (from > to) throw manualError('MANUAL_INVALID', 'windowFrom 不能晚于 windowTo');
    if (to - from > 14 * DAY_MS) throw manualError('MANUAL_INVALID', '预测窗口不能超过 14 天');
  }

  let createdAt, updatedAt;
  if (stored) {
    createdAt = canonicalIso(value.createdAt, 'createdAt');
    updatedAt = canonicalIso(value.updatedAt, 'updatedAt');
    if (Date.parse(createdAt) > Date.parse(updatedAt)) throw manualError('MANUAL_INVALID', 'createdAt 不能晚于 updatedAt');
  }
  return {
    ...(id ? { id } : {}),
    ...(tweetId ? { tweetId } : {}),
    ...(recordId ? { recordId } : {}),
    status: value.status,
    title: value.title.trim(),
    note,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(occurredAt ? { occurredAt } : {}),
    ...(windowFrom ? { windowFrom, windowTo } : {}),
    eventType,
    ...(createdAt ? { createdAt, updatedAt } : {}),
  };
}

function targetIds(entry) {
  return [entry.tweetId ? `tweet:${entry.tweetId}` : '', entry.recordId ? `record:${entry.recordId}` : ''].filter(Boolean);
}

function validateState(value) {
  if (!isObject(value) || Object.keys(value).some((key) => !['revision', 'entries', 'history'].includes(key))) {
    throw stateError('手动账本顶层格式错误');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.entries) || !Array.isArray(value.history)) {
    throw stateError('手动账本 revision、entries 或 history 格式错误');
  }
  if (value.entries.length > MAX_MANUAL_ENTRIES || value.history.length > MAX_MANUAL_HISTORY) {
    throw stateError('手动账本条数超过限制');
  }
  const ids = new Set(), targets = new Set();
  const entries = value.entries.map((entry) => {
    const normalized = validateManualEntry(entry, { stored: true, now: Date.now() });
    if (!normalized.id || ids.has(normalized.id)) throw stateError('手动账本 entry ID 缺失或重复');
    ids.add(normalized.id);
    for (const target of targetIds(normalized)) {
      if (targets.has(target)) throw stateError('手动账本同一目标存在重复更正');
      targets.add(target);
    }
    return normalized;
  });
  const history = value.history.map((item) => {
    if (!isObject(item) || !['save', 'withdraw'].includes(item.action) ||
        typeof item.entryId !== 'string' || !UUID_RE.test(item.entryId)) throw stateError('手动账本历史条目格式错误');
    let at;
    try { at = canonicalIso(item.at, 'history.at'); } catch { throw stateError('手动账本历史时间格式错误'); }
    if (!Object.hasOwn(item, 'before') || !Object.hasOwn(item, 'after') ||
        (item.before !== null && !isObject(item.before)) || (item.after !== null && !isObject(item.after))) {
      throw stateError('手动账本历史快照格式错误');
    }
    return { action: item.action, at, entryId: item.entryId,
      before: jsonClone(item.before), after: jsonClone(item.after) };
  });
  return { revision: value.revision, entries, history };
}

function emptyState() {
  return { revision: 0, entries: [], history: [] };
}

async function writeAtomic(path, serialized) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** 独立、原子、乐观并发控制的人工更正账本。 */
export function createManualStore(dataDir) {
  const path = resolve(dataDir, MANUAL_STATE_FILE);
  let queue = Promise.resolve();

  async function get() {
    let info;
    try { info = await stat(path); }
    catch (error) { if (error.code === 'ENOENT') return emptyState(); throw error; }
    if (info.size > MAX_MANUAL_STATE_BYTES) throw stateError('手动账本超过 2MB，拒绝读取');
    let raw;
    try { raw = await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return emptyState(); throw error; }
    if (Buffer.byteLength(raw, 'utf8') > MAX_MANUAL_STATE_BYTES) throw stateError('手动账本超过 2MB，拒绝读取');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw stateError('手动账本不是有效 JSON，拒绝当作空数据继续运行'); }
    return validateState(parsed);
  }

  function mutate(change) {
    const task = queue.then(async () => {
      if (!isObject(change)) throw manualError('MANUAL_INVALID', 'mutation 必须是 JSON 对象');
      const current = await get();
      if (!Number.isSafeInteger(change.revision) || change.revision < 0) {
        throw manualError('MANUAL_INVALID', 'revision 必须是非负整数');
      }
      if (change.revision !== current.revision) {
        throw manualError('REVISION_CONFLICT', '手动账本已被其他更改更新，请刷新后重试', 409);
      }
      const nowMs = normalizeNow(change.now ?? Date.now());
      const at = new Date(nowMs).toISOString();
      const next = jsonClone(current);
      let entryId, before = null, after = null;

      if (change.action === 'save') {
        const incoming = validateManualEntry(change.entry, { now: nowMs, account: change.account ?? DEFAULT_ACCOUNT });
        const byId = incoming.id ? next.entries.findIndex((entry) => entry.id === incoming.id) : -1;
        if (incoming.id && byId < 0) throw manualError('MANUAL_INVALID', 'entry.id 不存在，不能用它创建新条目');
        const matchingTargets = new Set(targetIds(incoming));
        const byTarget = next.entries.findIndex((entry) => targetIds(entry).some((target) => matchingTargets.has(target)));
        if (byId >= 0 && byTarget >= 0 && byId !== byTarget) {
          throw manualError('MANUAL_INVALID', 'entry.id 与目标已分别属于不同更正');
        }
        const index = byId >= 0 ? byId : byTarget;
        const existing = index >= 0 ? next.entries[index] : null;
        before = existing ? jsonClone(existing) : null;
        entryId = existing?.id ?? randomUUID();
        after = {
          ...incoming,
          id: entryId,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
        };
        if (index >= 0) next.entries[index] = after;
        else next.entries.push(after);
      } else if (change.action === 'withdraw') {
        entryId = change.entryId ?? change.id;
        if (typeof entryId !== 'string' || !UUID_RE.test(entryId)) throw manualError('MANUAL_INVALID', 'withdraw 需要有效 entryId');
        const index = next.entries.findIndex((entry) => entry.id === entryId);
        if (index < 0) throw manualError('MANUAL_INVALID', '要撤销的更正不存在');
        before = jsonClone(next.entries[index]);
        next.entries.splice(index, 1);
      } else {
        throw manualError('MANUAL_INVALID', 'action 必须是 save 或 withdraw');
      }

      if (next.entries.length > MAX_MANUAL_ENTRIES) throw manualError('MANUAL_LIMIT', '手动更正最多保存 1000 条', 413);
      next.revision++;
      next.history.push({ action: change.action, at, entryId, before, after: jsonClone(after) });
      if (next.history.length > MAX_MANUAL_HISTORY) throw manualError('MANUAL_LIMIT', '手动更正历史最多保存 5000 条', 413);
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_MANUAL_STATE_BYTES) {
        throw manualError('MANUAL_LIMIT', '手动账本将超过 2MB，未保存本次更改', 413);
      }
      const checked = validateState(next);
      await writeAtomic(path, serialized);
      return { ...jsonClone(checked), entryId, entry: jsonClone(after) };
    });
    queue = task.catch(() => {});
    return task;
  }

  return { path, get, mutate };
}

function officialStatusIdentity(value, account) {
  if (typeof value !== 'string') return null;
  const match = /^https:\/\/x\.com\/([^/]+)\/status\/(\d+)$/.exec(value);
  if (!match || match[1].toLowerCase() !== account.toLowerCase()) return null;
  return match[2];
}

function trustedSelfTweet(tweet, account) {
  return tweet?.author_verified === true && String(tweet.account ?? '').toLowerCase() === account.toLowerCase() &&
    ['timeline-browser', 'with-replies'].includes(tweet.foundVia) && /^\d+$/.test(String(tweet.id ?? ''));
}

function declaredProgramDay(text) {
  const match = String(text ?? '').match(/\bDay\s*(\d+)(?:\.\d+|\s*\([^)]*\))?\s*\//i);
  return match ? Number(match[1]) : null;
}

function verifiedParent(tweet, account) {
  const parent = tweet?.inReplyTo;
  if (!trustedSelfTweet(tweet, account) || parent?.verified !== true || parent.relation !== 'reply' ||
      String(parent.account ?? '').toLowerCase() !== account.toLowerCase() || !/^\d+$/.test(String(parent.id ?? '')) ||
      typeof parent.text !== 'string' || !parent.text.trim()) return null;
  const childAt = Date.parse(tweet.created_at), parentAt = Date.parse(parent.created_at);
  if (!Number.isFinite(childAt) || !Number.isFinite(parentAt) || parentAt >= childAt) return null;
  const parentUrlId = officialStatusIdentity(parent.url, account);
  if (parent.url && parentUrlId !== String(parent.id)) return null;
  return { id: String(parent.id), account: account.toLowerCase(), text: parent.text,
    created_at: new Date(parentAt).toISOString(), url: parent.url || '' };
}

function parentMatchesTweet(parent, tweet, account) {
  return trustedSelfTweet(tweet, account) && String(tweet.id) === parent.id &&
    String(tweet.account).toLowerCase() === parent.account && tweet.text === parent.text &&
    Date.parse(tweet.created_at) === Date.parse(parent.created_at) &&
    (!parent.url || officialStatusIdentity(tweet.url, account) === parent.id);
}

function parentSignature(parent) {
  return JSON.stringify([parent.id, parent.account, parent.created_at, parent.text, parent.url]);
}

function nearestDeclaredProgramDay(tweet, tweets, account, visited = new Set()) {
  if (!trustedSelfTweet(tweet, account)) return null;
  const ownDay = declaredProgramDay(tweet.text);
  if (ownDay !== null) return ownDay;
  const id = String(tweet.id);
  if (visited.has(id)) return null;
  visited.add(id);
  const relation = verifiedParent(tweet, account);
  if (!relation) return null;
  const parentTweet = (tweets ?? []).find((candidate) => parentMatchesTweet(relation, candidate, account));
  return parentTweet
    ? nearestDeclaredProgramDay(parentTweet, tweets, account, visited)
    : declaredProgramDay(relation.text);
}

/** 新 Day 编号与最近上游编号冲突时切边；无编号回复继承上游编号。 */
function verifiedReplyKeepsNearestProgramDay(tweet, relation, tweets, account) {
  const childDay = declaredProgramDay(tweet.text);
  if (childDay === null) return true;
  const parentTweet = (tweets ?? []).find((candidate) => parentMatchesTweet(relation, candidate, account));
  const parentDay = parentTweet
    ? nearestDeclaredProgramDay(parentTweet, tweets, account)
    : declaredProgramDay(relation.text);
  return parentDay === null || childDay === parentDay;
}

/** 先按最近上游 Day 声明切边，再求连通分量，令分组不依赖选中的链节点。 */
function verifiedSelfReplyGroup(target, tweets, account) {
  const candidates = (tweets ?? []).filter((tweet) => trustedSelfTweet(tweet, account));
  if (!target || !trustedSelfTweet(target, account)) return target ? new Set([String(target.id)]) : new Set();
  const adjacency = new Map(candidates.map((tweet) => [String(tweet.id), new Set()]));
  const sharedParents = new Map();
  const connect = (left, right) => {
    if (!adjacency.has(left) || !adjacency.has(right)) return;
    adjacency.get(left).add(right);
    adjacency.get(right).add(left);
  };
  for (const tweet of candidates) {
    const relation = verifiedParent(tweet, account);
    if (!relation || !verifiedReplyKeepsNearestProgramDay(tweet, relation, candidates, account)) continue;
    const id = String(tweet.id);
    const parentTweet = candidates.find((candidate) => parentMatchesTweet(relation, candidate, account));
    if (parentTweet) connect(id, String(parentTweet.id));
    const signature = parentSignature(relation);
    if (!sharedParents.has(signature)) sharedParents.set(signature, []);
    sharedParents.get(signature).push(id);
  }

  for (const siblings of sharedParents.values()) {
    for (let i = 1; i < siblings.length; i++) connect(siblings[0], siblings[i]);
  }
  const group = new Set(), pending = [String(target.id)];
  while (pending.length) {
    const id = pending.pop();
    if (group.has(id)) continue;
    group.add(id);
    for (const neighbor of adjacency.get(id) ?? []) if (!group.has(neighbor)) pending.push(neighbor);
  }
  return group;
}

function getRecordSourceIds(record, account) {
  const ids = new Set();
  if (/^\d+$/.test(String(record?.id ?? ''))) ids.add(String(record.id));
  for (const source of [record?.url, ...(Array.isArray(record?.confirmation_urls) ? record.confirmation_urls : [])]) {
    const id = officialStatusIdentity(source, account);
    if (id) ids.add(id);
  }
  return ids;
}

function resolveEntryTargets(entry, records, tweets, account) {
  const record = entry.recordId ? records.find((item) => String(item.id) === entry.recordId) :
    records.find((item) => {
      const ids = getRecordSourceIds(item, account);
      return (entry.tweetId && ids.has(entry.tweetId)) ||
        (entry.sourceUrl && ids.has(officialStatusIdentity(entry.sourceUrl, account)));
    });
  const tweet = entry.tweetId ? tweets.find((item) => String(item.id) === entry.tweetId) :
    tweets.find((item) => {
      const id = officialStatusIdentity(item.url, account);
      return (record && (String(item.id) === String(record.id) || getRecordSourceIds(record, account).has(String(item.id)))) ||
        (entry.sourceUrl && id === officialStatusIdentity(entry.sourceUrl, account));
    });
  const group = verifiedSelfReplyGroup(tweet, tweets, account);
  const allSourceIds = new Set(group);
  if (tweet) allSourceIds.add(String(tweet.id));
  if (record) for (const id of getRecordSourceIds(record, account)) allSourceIds.add(id);
  return { record, tweet, group, allSourceIds };
}

/** 将手动更正固定到已核验会话最早的原帖，保存后不再因点选回复产生第二个目标。 */
export function canonicalizeManualEntryTarget(entry, { resets = { records: [] }, tweets = { tweets: [] }, account = DEFAULT_ACCOUNT } = {}) {
  const rawRecords = Array.isArray(resets?.records) ? resets.records : [];
  const rawTweets = Array.isArray(tweets?.tweets) ? tweets.tweets : [];
  const normalizedAccount = String(account || DEFAULT_ACCOUNT).toLowerCase();
  const targets = resolveEntryTargets(entry, rawRecords, rawTweets, normalizedAccount);
  const groupTweets = [...targets.group]
    .map((id) => rawTweets.find((tweet) => String(tweet.id) === String(id)))
    .filter((tweet) => tweet && trustedSelfTweet(tweet, normalizedAccount))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || String(a.id).localeCompare(String(b.id)));
  const root = groupTweets[0];
  if (!root) return { entry: { ...entry }, groupTweetIds: [] };
  const { recordId, ...rest } = entry;
  return { entry: { ...rest, tweetId: String(root.id) }, groupTweetIds: [...targets.group].sort() };
}

function winningManualEntries(entries, records, tweets, account) {
  const ranked = entries.map((entry) => ({ entry, targets: resolveEntryTargets(entry, records, tweets, account) }))
    .sort((a, b) => Date.parse(b.entry.updatedAt) - Date.parse(a.entry.updatedAt) ||
      String(a.entry.id).localeCompare(String(b.entry.id)));
  const claimedTweetIds = new Set();
  const winners = [];
  for (const candidate of ranked) {
    const group = candidate.targets.group;
    if ([...group].some((id) => claimedTweetIds.has(String(id)))) continue;
    for (const id of group) claimedTweetIds.add(String(id));
    winners.push(canonicalizeManualEntryTarget(candidate.entry, {
      resets: { records }, tweets: { tweets }, account,
    }).entry);
  }
  return winners;
}

function manualDecision(entry, lead) {
  return {
    status: entry.status,
    lead,
    title: entry.title,
    note: entry.note,
    ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
    updatedAt: entry.updatedAt,
    ...(entry.windowFrom ? { windowFrom: entry.windowFrom, windowTo: entry.windowTo } : {}),
  };
}

function manualRecord(entry, targets, account, tweets) {
  const groupTweets = [...(targets.group ?? [])]
    .map((id) => (tweets ?? []).find((tweet) => String(tweet.id) === String(id)))
    .filter((tweet) => tweet && trustedSelfTweet(tweet, account))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const groupUrls = groupTweets.map((tweet) => officialStatusIdentity(tweet.url, account) ? tweet.url : null).filter(Boolean);
  const targetUrl = targets.tweet?.url && officialStatusIdentity(targets.tweet.url, account) ? targets.tweet.url : undefined;
  const url = entry.sourceUrl ?? groupUrls[0] ?? targetUrl ?? (entry.tweetId ? `https://x.com/${account}/status/${entry.tweetId}` : '');
  const confirmationUrls = [...new Set([url, ...groupUrls, targetUrl].filter(Boolean))];
  return {
    id: `manual-${entry.id}`,
    announced_at: entry.occurredAt,
    first_confirmed_at: entry.occurredAt,
    type: entry.eventType,
    text: entry.title,
    url,
    attribution: 'manual',
    manual: true,
    manualEntryId: entry.id,
    confirmation_urls: confirmationUrls,
  };
}

/**
 * 把 ledger 叠加到原始数据的副本上。调用方得到的任何对象都不会与采集缓存共享引用。
 */
export function projectManualData({ resets = { records: [] }, tweets = { tweets: [] }, statsFile = {}, manual = emptyState(), now = Date.now(), account = DEFAULT_ACCOUNT } = {}) {
  const nowMs = normalizeNow(now);
  const sourceAccount = String(account || DEFAULT_ACCOUNT).toLowerCase();
  const state = validateState(manual ?? emptyState());
  const rawRecords = Array.isArray(resets?.records) ? resets.records : [];
  const rawTweets = Array.isArray(tweets?.tweets) ? tweets.tweets : [];
  const activeEntries = winningManualEntries(state.entries, rawRecords, rawTweets, sourceAccount);
  const records = rawRecords.map(jsonClone);
  const effectiveTweets = rawTweets.map((tweet) => {
    const copy = jsonClone(tweet);
    delete copy.accountObservation;
    return copy;
  });
  const targetsByEntry = new Map();
  const suppressedSourceIds = new Set();
  const suppressedRecordIds = new Set();

  for (const entry of activeEntries) {
    const targets = resolveEntryTargets(entry, rawRecords, rawTweets, sourceAccount);
    targetsByEntry.set(entry.id, targets);
    if (entry.recordId) suppressedRecordIds.add(entry.recordId);
    for (const id of targets.allSourceIds) suppressedSourceIds.add(id);
  }

  // 旧账号实测反馈改为普通 reset 记录。若同一目标已有明确人工裁定，以裁定为准。
  const observations = [];
  const legacyGroups = [];
  const legacyGroupKeys = new Set();
  const legacySuppressedSourceIds = new Set();
  const preservedPublicRecordIds = new Set();
  for (const tweet of rawTweets) {
    const observation = readAccountObservation(tweet, { now: nowMs, account: sourceAccount });
    if (!observation || suppressedSourceIds.has(observation.announcementId)) continue;
    const group = verifiedSelfReplyGroup(tweet, rawTweets, sourceAccount);
    const key = [...group].sort().join('/');
    if (legacyGroupKeys.has(key)) continue;
    legacyGroupKeys.add(key);
    for (const id of group) legacySuppressedSourceIds.add(id);
    const completionIds = new Set();
    for (const related of rawTweets) {
      if (!group.has(String(related.id))) continue;
      const event = confirmedResetEvent(related, { account: sourceAccount, tweets: rawTweets, now: nowMs });
      if (event) completionIds.add(String(event.id));
    }
    const publicRecord = rawRecords
      .filter((record) => [...getRecordSourceIds(record, sourceAccount)].some((id) => completionIds.has(id)))
      .sort((a, b) => Date.parse(a.first_confirmed_at || a.announced_at) - Date.parse(b.first_confirmed_at || b.announced_at) ||
        String(a.id ?? '').localeCompare(String(b.id ?? '')))[0];
    if (publicRecord) preservedPublicRecordIds.add(String(publicRecord.id));
    legacyGroups.push({ observation, tweet, group, publicRecord });
    const sourceUrl = officialStatusIdentity(tweet.url, sourceAccount) ? tweet.url : '';
    if (!publicRecord) observations.push({
        id: `manual-account-${observation.announcementId}`,
        announced_at: observation.observedAt,
        first_confirmed_at: observation.observedAt,
        type: 'reset',
        text: tweet.text,
        url: sourceUrl,
        attribution: 'manual',
        manual: true,
        manualAccountObservation: true,
        confirmation_urls: sourceUrl ? [sourceUrl] : [],
      });
  }

  // 根帖统一作为该会话的手动到账主语，短回复只保留上下文位置，避免再次挂出预测。
  for (const { observation, tweet, group } of legacyGroups) {
    const entry = { status: 'landed', title: tweet.text, note: '维护者账号实测转为已到账',
      sourceUrl: officialStatusIdentity(tweet.url, sourceAccount) ? tweet.url : undefined,
      updatedAt: observation.observedAt };
    for (const effectiveTweet of effectiveTweets) {
      if (group.has(String(effectiveTweet.id))) {
        effectiveTweet.manualDecision = manualDecision(entry, String(effectiveTweet.id) === observation.announcementId);
      }
    }
  }

  const filteredRecords = records.filter((record) => {
    if (suppressedRecordIds.has(String(record.id))) return false;
    const ids = getRecordSourceIds(record, sourceAccount);
    if ([...ids].some((id) => suppressedSourceIds.has(id))) return false;
    if ([...ids].some((id) => legacySuppressedSourceIds.has(id))) {
      return preservedPublicRecordIds.has(String(record.id));
    }
    return true;
  });
  const manualRecords = [];
  const syntheticTweets = [];
  for (const entry of activeEntries) {
    const targets = targetsByEntry.get(entry.id);
    const linkedTweetId = targets?.tweet ? String(targets.tweet.id) : null;
    const targetIds = targets?.group?.size ? targets.group : linkedTweetId ? new Set([linkedTweetId]) : new Set();
    if (linkedTweetId) targetIds.add(linkedTweetId);
    for (const tweet of effectiveTweets) {
      if (targetIds.has(String(tweet.id))) tweet.manualDecision = manualDecision(entry, String(tweet.id) === linkedTweetId);
    }

    if (entry.status === 'landed') manualRecords.push(manualRecord(entry, targets ?? { group: new Set() }, sourceAccount, rawTweets));
    if (entry.status === 'announced' && !linkedTweetId) {
      syntheticTweets.push({
        id: `manual-${entry.id}`,
        text: entry.title,
        created_at: entry.updatedAt,
        url: entry.sourceUrl ?? '',
        author_verified: false,
        account: 'manual',
        foundVia: 'manual',
        kind: 'other',
        role: 'manual',
        manual: true,
        manualDecision: manualDecision(entry, true),
      });
    }
  }

  const effectiveRecords = [...filteredRecords, ...observations, ...manualRecords]
    .sort((a, b) => Date.parse(b.announced_at) - Date.parse(a.announced_at));
  const effectiveTweetsFile = {
    ...jsonClone(tweets ?? {}),
    tweets: [...effectiveTweets, ...syntheticTweets],
    manualRevision: state.revision,
  };
  const effectiveResetsFile = { ...jsonClone(resets ?? {}), records: effectiveRecords };
  const effectiveStatsFile = {
    ...jsonClone(statsFile ?? {}),
    stats: {
      ...buildStats(effectiveRecords),
      days_since_last: effectiveRecords.length
        ? (nowMs - Date.parse(effectiveRecords.reduce((latest, record) =>
          Date.parse(record.announced_at) > Date.parse(latest.announced_at) ? record : latest).announced_at)) / DAY_MS
        : null,
    },
  };
  return { resets: effectiveResetsFile, tweets: effectiveTweetsFile, statsFile: effectiveStatsFile, manual: state };
}
