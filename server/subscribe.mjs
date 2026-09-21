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
 * 推送时机只有一种：**确认发生了新的重置事件**。
 * 绝不在「模型预测可能重置」时推送 —— 那直接违反 PRD 的 0 误报要求。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { saveJson } from '../src/lib/collect.mjs';

const FILE = 'subscriptions.json';

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

  const empty = () => ({ schema: 1, updated_at: null, last_event_at: null, items: [] });

  return {
    path,

    async read() {
      try {
        const raw = JSON.parse(await readFile(path, 'utf8'));
        return {
          schema: 1,
          updated_at: raw.updated_at ?? null,
          last_event_at: raw.last_event_at ?? null,
          items: Array.isArray(raw.items) ? raw.items : [],
        };
      } catch {
        // 首次运行 / 文件坏了都退回空状态。订阅可以重新点，不该让服务起不来。
        return empty();
      }
    },

    async write(state) {
      const next = {
        schema: 1,
        updated_at: new Date().toISOString(),
        last_event_at: state.last_event_at ?? null,
        items: state.items.slice(0, MAX_ITEMS),
      };
      await saveJson(path, next);
      return next;
    },
  };
}

/* ------------------------------ 纯函数（可测） ------------------------------ */

/**
 * 找出「晚于 lastEventAt」的重置记录。
 *
 * 判据刻意简单：只看 announced_at 比水位线新。这不需要理解记录内容，
 * 也不依赖采集侧是否去重 —— 采集重跑不会造成重复推送，因为水位线只升不降。
 */
export function detectNewResets(records, lastEventAt) {
  const since = Date.parse(lastEventAt);
  const hasSince = Number.isFinite(since);
  return (records ?? [])
    .filter((r) => {
      const t = Date.parse(r?.announced_at);
      return Number.isFinite(t) && (!hasSince || t > since);
    })
    .sort((a, b) => Date.parse(a.announced_at) - Date.parse(b.announced_at));
}

/** 记录里最新的 announced_at（毫秒）。空集合返回 null */
export function latestEventAt(records) {
  let max = null;
  for (const r of records ?? []) {
    const t = Date.parse(r?.announced_at);
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

  let records;
  try {
    records = JSON.parse(await readFile(resolve(dataDir, 'resets.json'), 'utf8')).records ?? [];
  } catch {
    return { skipped: 'no-resets' };
  }

  const maxAt = latestEventAt(records);
  if (maxAt === null) return { skipped: 'no-resets' };

  const state = await store.read();

  // 首次运行只记水位线，不推。
  // 否则一上线就会把「历史最近一次重置」当成新事件推给所有人。
  if (!state.last_event_at) {
    state.last_event_at = new Date(maxAt).toISOString();
    await store.write(state);
    return { skipped: 'baseline-initialized', lastEventAt: state.last_event_at };
  }

  const fresh = detectNewResets(records, state.last_event_at);
  if (!fresh.length) return { skipped: 'no-new-event', lastEventAt: state.last_event_at };

  const newest = fresh[fresh.length - 1];
  const vars = {
    event: '额度重置',
    time: fmtWeChatTime(Date.parse(newest.announced_at)),
    eta: '已重置，本轮结束',
  };
  const data = buildTemplateData(vars, templateSpec);

  let sent = 0;
  let failed = 0;
  const removed = [];
  const survivors = [];

  for (const item of state.items) {
    try {
      await client.sendSubscribeMessage({ openid: item.openid, templateId, page, data });
      sent++;
      // 一次性订阅已消耗，成功即删除 —— 留着只会让下一轮推送必然失败
    } catch (err) {
      failed++;
      if (err.permanent) {
        removed.push(item.openid);
        log.warn?.(`[subscribe] 永久失败，已移除订阅：${err.message}`);
      } else {
        survivors.push(item);
        log.warn?.(`[subscribe] 推送失败（保留订阅）：${err.message}`);
      }
    }
    if (SEND_GAP_MS) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
  }

  // 水位线只升不降：即使全部推送失败也不回退，否则下一轮会重推同一事件
  state.items = survivors;
  state.last_event_at = new Date(maxAt).toISOString();
  await store.write(state);

  return {
    event: newest.announced_at,
    candidates: state.items.length + sent + removed.length,
    sent,
    failed,
    removed: removed.length,
  };
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
export async function handleSubscribe(req, res, { store, client, templateId, send }) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!client?.configured) {
    return send(res, 503, {
      error: 'subscribe disabled',
      hint: '未配置 WX_APPID / WX_SECRET，订阅能力已关闭',
    });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return send(res, err.status ?? 400, { error: err.message });
  }

  const tmpl = String(payload.templateId ?? templateId ?? '').trim();
  if (!tmpl) return send(res, 422, { error: 'missing templateId' });

  let openid;
  try {
    openid = await client.codeToOpenid(payload.code);
  } catch (err) {
    // 换 openid 失败多半是 code 过期/复用 —— 这是客户端能修的，回 400 而不是 500
    return send(res, 400, { error: 'code 换取 openid 失败', detail: err.message });
  }

  const state = await store.read();
  const nowIso = new Date().toISOString();
  const idx = state.items.findIndex((x) => x.openid === openid && x.template_id === tmpl);
  if (idx >= 0) {
    state.items[idx] = { ...state.items[idx], created_at: nowIso };
  } else {
    state.items.push({ openid, template_id: tmpl, created_at: nowIso, notified_at: null });
  }
  await store.write(state);

  return send(res, 200, { ok: true, total: Math.min(state.items.length, MAX_ITEMS), scope: 'once' });
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
  } catch (err) {
    return send(res, err.status ?? 400, { error: err.message });
  }

  let openid;
  try {
    openid = await client.codeToOpenid(payload.code);
  } catch (err) {
    return send(res, 400, { error: 'code 换取 openid 失败', detail: err.message });
  }

  const state = await store.read();
  const before = state.items.length;
  state.items = state.items.filter((x) => x.openid !== openid);
  await store.write(state);

  return send(res, 200, { ok: true, removed: before - state.items.length });
}
