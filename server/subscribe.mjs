/**
 * F9 一次性订阅消息链路。
 *
 * 先说清楚这个功能**做不到什么**（微信平台限制，不是实现选择）：
 * 长期订阅只对政务 / 医疗 / 交通等特定类目开放，工具类目拿不到。
 * 所以这里只能做「**一次授权 = 一次通知**」：用户点一次，下次重置推一条，推完即失效。
 * 要再收到得重新进小程序授权。绕过这个限制（诱导连续授权）是微信明令禁止的。
 *
 * 产品定位因此是**重要事件提醒**，不是订阅推送。这个限制必须写进小程序文案，
 * 否则用户会以为「订阅了就永久通知」—— 那是我们骗了他。
 *
 * 预告与落地是两种独立事件、两份一次性授权。预告只来自仍有效的明确公告；
 * 落地只来自已确认的 reset / credit 记录。模型概率、hint 与每日窗口都不触发通知。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { saveJson } from '../src/lib/collect.mjs';

const FILE = 'subscriptions.json';
const SUBSCRIPTION_KINDS = Object.freeze(['announcement', 'landed']);

function normalizeKind(value) {
  return value === undefined ? 'landed' : value;
}

function configuredTemplateIds(templateIds, legacyTemplateId) {
  if (templateIds === undefined) {
    const id = typeof legacyTemplateId === 'string' ? legacyTemplateId.trim() : '';
    return { announcement: id, landed: id };
  }
  if (!templateIds || typeof templateIds !== 'object' || Array.isArray(templateIds)) {
    return { announcement: '', landed: '' };
  }
  const normalize = (value) => typeof value === 'string' && value === value.trim() ? value : '';
  const ids = {
    announcement: normalize(templateIds.announcement),
    landed: normalize(templateIds.landed),
  };
  if (ids.announcement && ids.announcement === ids.landed) ids.announcement = '';
  return ids;
}

function itemKind(item) {
  // 老名单没有 kind，历史上的授权始终表示「确认落地后通知」。
  return item?.kind === 'announcement' ? 'announcement' : 'landed';
}

/** 订阅条数上限。个人小程序量级远小于此，设上限只为防存储被写爆 */
const MAX_ITEMS = 20000;

/** 逐个发送，间隔 50ms。微信侧有频率限制，并发发只会一起被拒 */
const SEND_GAP_MS = 50;

/** 请求体上限：这里只有 code 与模板 ID */
const MAX_BODY_BYTES = 8 * 1024;

/* ------------------------------ 存储 ------------------------------ */

/** 一个 openid 一条订阅。量级小，沿用与采集数据一致的「JSON + 原子写」 */
export function createSubscriptionStore(dataDir) {
  const path = resolve(dataDir, FILE);
  let updates = Promise.resolve();
  let notifications = Promise.resolve();

  const empty = () => ({ schema: 1, updated_at: null, last_event_at: null, announcement_ids: [], items: [] });

  const store = {
    path,

    async read() {
      try {
        const raw = JSON.parse(await readFile(path, 'utf8'));
        if (!Array.isArray(raw.items)) throw new Error('订阅名单格式错误');
        return {
          schema: 1,
          updated_at: raw.updated_at ?? null,
          last_event_at: raw.last_event_at ?? null,
          announcement_ids: Array.isArray(raw.announcement_ids) ? raw.announcement_ids : [],
          items: raw.items.map((item) => ({ ...item, kind: itemKind(item) })),
        };
      } catch (err) {
        if (err.code === 'ENOENT') return empty();
        // 损坏的名单不能当作空文件覆盖，否则已授权用户会无声丢失。
        throw err;
      }
    },

    async write(state) {
      const next = {
        schema: 1,
        updated_at: new Date().toISOString(),
        last_event_at: state.last_event_at ?? null,
        announcement_ids: state.announcement_ids ?? [],
        items: state.items,
      };
      await saveJson(path, next);
      return next;
    },
    update(change) {
      const task = updates.then(async () => {
        const state = await store.read();
        const result = await change(state);
        await store.write(state);
        return result;
      });
      updates = task.catch(() => {});
      return task;
    },
    notify(job) {
      // 发送串行，名单更新只锁住短事务；微信请求不会阻塞新用户登记。
      const task = notifications.then(job);
      notifications = task.catch(() => {});
      return task;
    },
  };
  return store;
}

/* ------------------------------ 纯函数（可测） ------------------------------ */

/**
 * 找出「晚于 lastEventAt」的重置记录。
 *
 * 仅接受明确标记的 reset/credit，时间取首次确认时刻，且不晚于当前时间。
 * 后续确认补正不构成新的重置，未知类型也不能消耗用户的一次授权。
 */
const eventTime = (r) => Date.parse(r?.first_confirmed_at || r?.announced_at);

export function detectNewResets(records, lastEventAt, now = Date.now()) {
  const since = Date.parse(lastEventAt);
  const hasSince = Number.isFinite(since);
  return (records ?? [])
    .filter((r) => {
      const t = eventTime(r);
      return Number.isFinite(t) && t <= now && (!hasSince || t > since) &&
        (r.type === 'reset' || r.type === 'credit');
    })
    .sort((a, b) => eventTime(a) - eventTime(b));
}

/** 记录里最新的 announced_at（毫秒）。空集合返回 null */
export function latestEventAt(records) {
  let max = null;
  for (const r of detectNewResets(records, null)) {
    const t = eventTime(r);
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max;
}

/**
 * 组装订阅消息的 data。
 *
 * ⚠ 字段名（thing1 / time2 / thing3）必须与你在微信后台建的模板一致。
 *   不同模板的字段名和类型都不一样，这里给的是一份常见组合的默认值；
 *   要改不用动代码 —— 用 `WX_TEMPLATE_DATA` 环境变量覆盖整份 data 即可，
 *   值里可以写 `{time}` / `{eta}` / `{event}` 三个占位符。
 *
 * 微信对字段值有格式约束：time 类型必须是 `YYYY-MM-DD HH:mm`，长度也有上限，
 * 所以这里的值都做了截断。
 */
export function buildTemplateData(vars, spec) {
  const fill = (s) =>
    String(s ?? '')
      .replace(/\{time\}/g, vars.time)
      .replace(/\{eta\}/g, vars.eta)
      .replace(/\{event\}/g, vars.event)
      .slice(0, 20);

  if (!spec || typeof spec !== 'object') {
    return {
      thing1: { value: fill('{event}') },
      time2: { value: fill('{time}') },
      thing3: { value: fill('{eta}') },
    };
  }

  const out = {};
  for (const [key, val] of Object.entries(spec)) {
    out[key] = { value: fill(typeof val === 'string' ? val : val?.value) };
  }
  return out;
}

/** 北京时间 `YYYY-MM-DD HH:mm` —— 微信 time 类字段要的形状 */
export function fmtWeChatTime(ts) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  const g = (type) => p.find((x) => x.type === type)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

/* ------------------------------ 推送 ------------------------------ */

/**
 * 检测新重置事件并推送。**由 ingest 落盘后调用**。
 *
 * @returns {Promise<object>} 结果摘要，写进日志用
 */
export async function notifyNewResets({ dataDir, store, client, templateId, page, templateSpec, log = console }) {
  if (!templateId) return { skipped: 'no-template-id' };
  if (!client?.configured) return { skipped: 'wechat-not-configured' };
  return store.notify(async () => {
    const records = JSON.parse(await readFile(resolve(dataDir, 'resets.json'), 'utf8')).records ?? [];
    const maxAt = latestEventAt(records);
    const confirmedTimes = new Set(detectNewResets(records, null).map((record) => eventTime(record)));
    const work = await store.update((state) => {
      // 修正/撤回的完成记录不能继续支撑旧待发项；旧名单只存时间戳时也按同一口径核验。
      for (const item of state.items) {
        if (item.pending_event_at && !confirmedTimes.has(Date.parse(item.pending_event_at))) delete item.pending_event_at;
      }
      if (maxAt === null) return { skipped: 'no-resets' };
      if (!state.last_event_at) {
        state.last_event_at = new Date(maxAt).toISOString();
        return { skipped: 'baseline-initialized', lastEventAt: state.last_event_at };
      }
      const fresh = detectNewResets(records, state.last_event_at);
      const newest = fresh[fresh.length - 1];
      if (newest) {
        const at = new Date(eventTime(newest)).toISOString();
        for (const item of state.items) {
          if (itemKind(item) !== 'landed' || item.template_id !== templateId || Date.parse(item.created_at) > eventTime(newest)) continue;
          item.id ||= randomUUID();
          item.pending_event_at ||= at;
        }
        state.last_event_at = new Date(Math.max(Date.parse(state.last_event_at), maxAt)).toISOString();
      }
      const items = state.items.filter((x) => itemKind(x) === 'landed' && x.template_id === templateId && x.pending_event_at);
      return items.length ? { items: structuredClone(items) } : { skipped: 'no-new-event', lastEventAt: state.last_event_at };
    });
    if (work.skipped) return work;
    let sent = 0, failed = 0, removed = 0;
    for (const item of work.items) {
      // 长批次等待期间，重置记录可能被修正；发送前重新确认硬事实仍在当前快照中。
      let currentTimes;
      try {
        const currentRecords = JSON.parse(await readFile(resolve(dataDir, 'resets.json'), 'utf8')).records ?? [];
        currentTimes = new Set(detectNewResets(currentRecords, null).map((record) => eventTime(record)));
      } catch (err) {
        failed++;
        log.warn?.(`[subscribe] 无法复核落地记录，保留待发授权：${err.message}`);
        continue;
      }
      const eligible = await store.update((state) => {
        const current = state.items.find((x) => x.id === item.id && itemKind(x) === 'landed' && x.template_id === templateId);
        if (!current) return false;
        if (!currentTimes.has(Date.parse(current.pending_event_at))) {
          delete current.pending_event_at;
          return false;
        }
        return true;
      });
      if (!eligible) continue;
      let consume = false;
      try {
        await client.sendSubscribeMessage({
          openid: item.openid, templateId, page,
          data: buildTemplateData({ event: '重置已落地｜公开完成公告已确认', time: fmtWeChatTime(Date.parse(item.pending_event_at)), eta: '查看观测台了解详情' }, templateSpec),
        });
        sent++;
        consume = true;
      } catch (err) {
        failed++;
        if (err.permanent) { removed++; consume = true; }
        log.warn?.(`[subscribe] ${err.permanent ? '授权失效，移除订阅' : '发送失败，下轮重试'}：${err.message}`);
      }
      if (consume) await store.update((state) => { state.items = state.items.filter((x) => x.id !== item.id); });
      if (SEND_GAP_MS) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    }
    return { candidates: work.items.length, sent, failed, removed };
  });
}

/**
 * 从信号识别的 forecasts 中取仍有效、带硬证据的明确预告。
 * 日期预告按 signals.mjs 已归并的窗口日去重；短时窗口按有效起止时刻标识；
 * 未定时间预告按最早硬证据 ID 稳定标识。
 */
export function announcementEventsFromForecasts(forecasts, now = Date.now()) {
  const events = [];
  for (const forecast of forecasts ?? []) {
    if (forecast?.level !== 'explicit') continue;
    const hard = (forecast.evidence ?? [])
      .filter((e) => e?.weight === 'hard' && (typeof e.id === 'string' || typeof e.id === 'number') && String(e.id).trim() &&
        Number.isFinite(Date.parse(e.createdAt)) && Date.parse(e.createdAt) <= now);
    if (!hard.length) continue;
    const createdAt = Date.parse(forecast.createdAt);
    if (!Number.isFinite(createdAt) || createdAt > now) continue;

    let id;
    if (forecast.window && Number.isFinite(forecast.window.dayNum)) {
      // buildForecasts 把同一窗口日定义为一条预告，新增同日依据不应重复提醒。
      id = `day:${forecast.window.dayNum}`;
    } else if (forecast.window) {
      const from = Date.parse(forecast.window.from);
      const to = Date.parse(forecast.window.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
      // 小时级窗口没有 dayNum；规范化边界后仍可跨采集轮次稳定去重。
      id = `window:${new Date(from).toISOString()}:${new Date(to).toISOString()}`;
    } else if (forecast.timing === 'pending' && forecast.window === null) {
      const first = hard.reduce((a, b) => Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? a : b);
      id = `pending:${first.id}`;
    } else {
      continue;
    }
    events.push({
      id,
      keys: [id, ...new Set(hard.map((e) => `tweet:${String(e.id)}`))],
      created_at: new Date(createdAt).toISOString(),
      text: typeof forecast.text === 'string' ? forecast.text : '',
      url: typeof forecast.url === 'string' ? forecast.url : '',
    });
  }
  const merged = new Map();
  for (const event of events) {
    const prior = merged.get(event.id);
    merged.set(event.id, prior ? { ...prior, keys: [...new Set([...prior.keys, ...event.keys])] } : event);
  }
  return [...merged.values()]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** 发送一条当前有效的明确预告。预告名单与落地名单、水位和授权互相独立。 */
export async function notifyNewAnnouncements({ store, client, templateId, page, templateSpec, forecasts, getForecasts, now = Date.now(), log = console }) {
  if (!templateId) return { skipped: 'no-template-id' };
  if (!client?.configured) return { skipped: 'wechat-not-configured' };
  const readForecasts = async () => typeof getForecasts === 'function' ? getForecasts() : forecasts;
  let initialForecasts;
  try { initialForecasts = await readForecasts(); }
  catch (err) {
    log.warn?.(`[subscribe] 无法读取当前预告，保留待发授权：${err.message}`);
    return { skipped: 'forecast-source-unavailable' };
  }
  const events = announcementEventsFromForecasts(initialForecasts, now);
  return store.notify(async () => {
    const work = await store.update((state) => {
      state.announcement_ids ||= [];
      const seen = new Set(state.announcement_ids);
      // 暂时失败的预告只在当前仍有效时重试；被撤回、兑现或过期后删除待发送项，
      // 但不消耗用户授权。按硬证据推文 ID 别名匹配，允许 pending 预告补上日期。
      for (const item of state.items) {
        const pending = item.pending_announcement;
        if (!pending) continue;
        const current = events.find((event) => event.keys.some((key) => pending.keys?.includes(key) || key === pending.id));
        if (current) item.pending_announcement = current;
        else delete item.pending_announcement;
      }
      const fresh = [];
      for (const event of events) {
        if (!event.keys.some((key) => seen.has(key))) fresh.push(event);
        for (const key of event.keys) {
          if (seen.has(key)) continue;
          seen.add(key);
          state.announcement_ids.push(key);
        }
      }
      for (const event of fresh) {
        for (const item of state.items) {
          if (itemKind(item) !== 'announcement' || item.template_id !== templateId ||
            !Number.isFinite(Date.parse(item.created_at)) || Date.parse(item.created_at) >= Date.parse(event.created_at)) continue;
          item.id ||= randomUUID();
          if (!item.pending_announcement) item.pending_announcement = event;
        }
      }
      const items = state.items.filter((item) => itemKind(item) === 'announcement' &&
        item.template_id === templateId && item.pending_announcement?.id);
      return items.length ? { items: structuredClone(items) } : {
        skipped: events.length ? 'no-new-announcement' : 'no-valid-announcement',
        seen: fresh.length,
      };
    });
    if (work.skipped) return work;
    let sent = 0, failed = 0, removed = 0;
    for (const item of work.items) {
      let currentEvents;
      try {
        currentEvents = announcementEventsFromForecasts(await readForecasts());
      } catch (err) {
        failed++;
        log.warn?.(`[subscribe] 无法复核预告有效性，保留待发授权：${err.message}`);
        continue;
      }
      const latestEvent = currentEvents.find((event) => event.keys.some((key) =>
        item.pending_announcement.keys?.includes(key) || key === item.pending_announcement.id));
      if (!latestEvent) {
        await store.update((state) => {
          for (const current of state.items) {
            if (current.id === item.id && current.pending_announcement?.id === item.pending_announcement?.id) {
              delete current.pending_announcement;
            }
          }
        });
        continue;
      }
      // 发送前再次检查名单，且将仍有效的最新窗口写回，退订和 pending→dated 修正都生效。
      const eligible = await store.update((state) => {
        const current = state.items.find((x) => x.id === item.id && x.pending_announcement?.id === item.pending_announcement?.id);
        if (!current) return false;
        current.pending_announcement = latestEvent;
        return true;
      });
      if (!eligible) continue;
      let consume = false;
      try {
        await client.sendSubscribeMessage({
          openid: item.openid, templateId, page,
          data: buildTemplateData({
            event: '重置预告｜尚未确认落地',
            time: fmtWeChatTime(Date.parse(latestEvent.created_at)),
            eta: '尚未确认重置完成',
          }, templateSpec),
        });
        sent++;
        consume = true;
      } catch (err) {
        failed++;
        if (err.permanent) { removed++; consume = true; }
        log.warn?.(`[subscribe] ${err.permanent ? '授权失效，移除预告订阅' : '预告发送失败，下轮重试'}：${err.message}`);
      }
      if (consume) await store.update((state) => {
        state.items = state.items.filter((x) => !(x.id === item.id && x.pending_announcement?.id === latestEvent.id));
      });
      if (SEND_GAP_MS) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    }
    return { candidates: work.items.length, sent, failed, removed };
  });
}

/* ------------------------------ 端点 ------------------------------ */

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('请求体过大');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `POST /api/subscribe` → 落一条一次性订阅。
 *
 * openid **必须**由服务端用 code 换，不接受客户端传 openid ——
 * 否则任何人都能伪造别人的身份去订阅或退订。
 *
 * 注意 code 是一次性的：小程序端每次调用前都要重新 wx.login。
 */
export async function handleSubscribe(req, res, { store, client, templateId, templateIds, send }) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!client?.configured) {
    return send(res, 503, {
      error: 'subscribe disabled',
      hint: '未配置 WX_APPID / WX_SECRET，订阅能力已关闭',
    });
  }

  const payload = await subscriptionPayload(req, res, { templateId, templateIds, send });
  if (!payload) return;

  let openid;
  try {
    openid = await client.codeToOpenid(payload.code);
  } catch (err) {
    // 换 openid 失败多半是 code 过期/复用 —— 这是客户端能修的，回 400 而不是 500
    return send(res, 400, { error: 'code 换取 openid 失败', detail: err.message });
  }

  const nowIso = new Date().toISOString();
  let records = [];
  try { records = JSON.parse(await readFile(resolve(store.path, '..', 'resets.json'), 'utf8')).records ?? []; }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  const result = await store.update((state) => {
    // 在第一次订阅时建立历史基线，不能等下一次 ingest 才初始化而漏掉首条新重置。
    if (payload.kind === 'landed') {
      state.last_event_at ||= new Date(latestEventAt(records) ?? Date.parse(nowIso)).toISOString();
    }
    const exists = state.items.some((x) => x.openid === openid && x.template_id === payload.templateId && itemKind(x) === payload.kind &&
      (payload.grantId ? x.grant_id === payload.grantId : true));
    if (!exists && state.items.length >= MAX_ITEMS) return false;
    if (!exists) state.items.push({
      id: randomUUID(), openid, template_id: payload.templateId, kind: payload.kind, created_at: nowIso,
      ...(payload.grantId ? { grant_id: payload.grantId } : {}),
    });
    return true;
  });
  return result
    ? send(res, 200, { ok: true, active: true, kind: payload.kind, scope: 'once' })
    : send(res, 503, { error: '提醒人数已达上限，请稍后再试' });
}

async function subscriptionPayload(req, res, { templateId, templateIds, send }) {
  try {
    const body = JSON.parse(await readBody(req));
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.code !== 'string' || !body.code.trim() || body.code.length > 256) {
      send(res, 400, { error: '缺少有效登录 code' }); return null;
    }
    const kind = normalizeKind(body.kind);
    if (!SUBSCRIPTION_KINDS.includes(kind)) { send(res, 400, { error: '通知类型无效' }); return null; }
    if (body.grantId !== undefined && (typeof body.grantId !== 'string' || !body.grantId.trim() || body.grantId !== body.grantId.trim() || body.grantId.length > 128)) {
      send(res, 400, { error: '授权标识无效' }); return null;
    }
    const expectedTemplateId = configuredTemplateIds(templateIds, templateId)[kind];
    if (!expectedTemplateId) { send(res, 503, { error: '该类型提醒尚未配置' }); return null; }
    if (body.templateId !== expectedTemplateId) {
      send(res, 422, { code: 'template_changed', error: '通知模板已变化，请重新进入小程序' });
      return null;
    }
    return { ...body, kind, templateId: expectedTemplateId, grantId: body.grantId || undefined };
  } catch (err) { send(res, err.status ?? 400, { error: '订阅请求格式错误' }); return null; }
}

/** 模板是公开标识；凭据和字段映射不出服务端。 */
export function handleSubscriptionConfig(req, res, { client, templateId, templateIds, send }) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const ids = configuredTemplateIds(templateIds, templateId);
  if (ids.announcement && ids.announcement === ids.landed) ids.announcement = '';
  const kinds = client?.configured ? SUBSCRIPTION_KINDS.filter((kind) => ids[kind]) : [];
  const enabled = kinds.length > 0;
  return send(res, 200, {
    enabled,
    // 旧客户端把这一个 ID 当成落地通知模板；保留其语义与接口字段。
    templateId: enabled && kinds.includes('landed') ? ids.landed : '',
    templateIds: enabled ? ids : { announcement: '', landed: '' },
    kinds,
    scope: 'once',
  });
}

export async function handleSubscriptionStatus(req, res, { store, client, templateId, templateIds, send }) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!client?.configured) return send(res, 503, { error: '重置通知尚未配置' });
  const payload = await subscriptionPayload(req, res, { templateId, templateIds, send });
  if (!payload) return;
  let openid;
  try { openid = await client.codeToOpenid(payload.code); }
  catch { return send(res, 400, { error: '登录已过期，请重试' }); }
  const state = await store.read();
  return send(res, 200, {
    ok: true,
    active: state.items.some((x) => x.openid === openid && x.template_id === payload.templateId && itemKind(x) === payload.kind &&
      (!payload.grantId || x.grant_id === payload.grantId)),
    kind: payload.kind,
    ...(payload.grantId ? { grantId: payload.grantId } : {}),
    scope: 'once',
  });
}

/**
 * `POST /api/unsubscribe` → 移除订阅。
 * 同样用 code 换 openid：退订接口若接受明文 openid，就成了「任意退订他人」的入口。
 */
export async function handleUnsubscribe(req, res, { store, client, send }) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!client?.configured) return send(res, 503, { error: 'subscribe disabled' });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
    if (!payload || typeof payload.code !== 'string' || !payload.code.trim() || payload.code.length > 256) return send(res, 400, { error: '缺少有效登录 code' });
    if (payload.kind !== undefined && !SUBSCRIPTION_KINDS.includes(payload.kind)) return send(res, 400, { error: '通知类型无效' });
  } catch (err) {
    return send(res, err.status ?? 400, { error: err.message });
  }

  let openid;
  try {
    openid = await client.codeToOpenid(payload.code);
  } catch (err) {
    return send(res, 400, { error: 'code 换取 openid 失败', detail: err.message });
  }

  const removed = await store.update((state) => {
    const before = state.items.length;
    state.items = state.items.filter((x) => x.openid !== openid ||
      (payload.kind !== undefined && itemKind(x) !== payload.kind));
    return before - state.items.length;
  });
  return send(res, 200, { ok: true, removed });
}
