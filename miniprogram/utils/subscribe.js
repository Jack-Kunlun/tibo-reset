/**
 * F9 一次性订阅消息 —— 小程序端。
 *
 * 先说清楚这里的限制，因为它决定了整个交互的写法：
 *
 *   **一次授权 = 一次通知。** 长期订阅不对工具类目开放（政务 / 医疗 / 交通才有）。
 *   用户分别给「明确预告」和「公开完成公告」授权；每类授权推一条后即消耗。
 *   要再收到该类通知，得重新进小程序再点一次。
 *
 * 所以入口文案必须说成「**下次重置提醒我一次**」，不能说「订阅通知」——
 * 后者会让用户以为一次授权就永久有效，那是我们误导了他。
 * 诱导连续授权（一次点按批十次）是微信明令禁止的，不做。
 *
 * 另一条：openid 由服务端用 code 换，客户端不碰 openid。code 是一次性的，
 * 因此**每次调用前都要重新 wx.login**，不能复用上一次的 code。
 */

import config from '../config.js';
import { postJson, request } from './api.js';

/** 入口文案：一次性限制写进按钮旁的说明，不靠用户猜 */
export const SCOPE_HINT = '一次授权只能收到一次通知，用完需要重新开启';
export const ACTION_LABELS = Object.freeze({ announcement: '开启预告提醒', landed: '开启落地提醒' });
export const DONE_LABELS = Object.freeze({ announcement: '已开启预告', landed: '已开启落地' });
export const ACTION_LABEL = ACTION_LABELS.landed;
export const DONE_LABEL = DONE_LABELS.landed;
const PENDING_KEYS = Object.freeze({
  announcement: 'tibo_announcement_sync_pending_v1',
  landed: 'tibo_landed_sync_pending_v1',
});
const LEGACY_PENDING_KEY = 'tibo_remind_sync_pending_v1';
const VALID_KINDS = ['announcement', 'landed'];
let serverTemplateId = '';
let supportedKinds = new Set(['landed']);
let serverConfigEnabled = false;
let grantSequence = 0;
const template = () => serverTemplateId;

function kindOrThrow(kind = 'landed') {
  if (!VALID_KINDS.includes(kind)) throw new Error('通知类型无效');
  return kind;
}

export async function loadSubscriptionConfig() {
  if (!config.enabled) { serverTemplateId = ''; supportedKinds = new Set(); serverConfigEnabled = false; return false; }
  let result;
  try { result = await request('/api/subscribe/config'); }
  catch (err) {
    serverTemplateId = '';
    supportedKinds = new Set();
    serverConfigEnabled = false;
    throw err;
  }
  serverConfigEnabled = result.enabled === true;
  serverTemplateId = result.enabled === true && typeof result.templateId === 'string' ? result.templateId.trim() : '';
  // 旧服务不返回 kinds：完成通知沿用旧接口，预告通知明确显示服务待升级。
  const kinds = Array.isArray(result.kinds) ? result.kinds.filter((kind) => VALID_KINDS.includes(kind)) : ['landed'];
  supportedKinds = result.enabled === true ? new Set(kinds) : new Set();
  return subscribeAvailable();
}

export function hasPendingSync(kind = 'landed') {
  kindOrThrow(kind);
  try {
    return pendingRecord(kind)?.templateId === template() && Boolean(template());
  }
  catch { return false; }
}

function pendingRecord(kind) {
  const pending = wx.getStorageSync(PENDING_KEYS[kind]);
  const legacy = kind === 'landed' ? wx.getStorageSync(LEGACY_PENDING_KEY) : '';
  const value = pending || legacy;
  if (typeof value === 'string') return value ? { templateId: value, grantId: '' } : null;
  if (!value || typeof value !== 'object' || typeof value.templateId !== 'string') return null;
  return {
    templateId: value.templateId,
    grantId: typeof value.grantId === 'string' ? value.grantId : '',
  };
}

function pendingSync(on, kind = 'landed', record = {}) {
  kindOrThrow(kind);
  try {
    if (on) {
      const templateId = typeof record.templateId === 'string' ? record.templateId : template();
      wx.setStorageSync(PENDING_KEYS[kind], {
        templateId,
        grantId: typeof record.grantId === 'string' ? record.grantId : '',
      });
    } else {
      const current = pendingRecord(kind);
      // 状态查询或较早请求完成时，不能清掉后来新授权留下的待办。
      const matches = (!Object.prototype.hasOwnProperty.call(record, 'templateId') || current?.templateId === record.templateId) &&
        (!Object.prototype.hasOwnProperty.call(record, 'grantId') || current?.grantId === (record.grantId || ''));
      if (matches) wx.removeStorageSync(PENDING_KEYS[kind]);
    }
    if (kind === 'landed') wx.removeStorageSync(LEGACY_PENDING_KEY);
  } catch { /* 不把已同步状态持久化，避免发送后仍显示永久开启。 */ }
}

export async function subscriptionStatus(kind = 'landed') {
  kindOrThrow(kind);
  const pending = pendingRecord(kind);
  const code = await login();
  const result = await postJson('/api/subscribe/status', {
    code, templateId: template(), kind,
    ...(pending?.templateId === template() && pending.grantId ? { grantId: pending.grantId } : {}),
  });
  if (result.ok !== true || typeof result.active !== 'boolean') throw new Error('提醒状态暂时无法确认');
  // 旧服务可能只回答「该类是否有任一授权」；它不能确认新 grant 已登记。
  const grantConfirmed = !pending?.grantId || result.grantId === pending.grantId;
  const active = result.active && grantConfirmed;
  if (active && pending) pendingSync(false, kind, pending);
  return active;
}

/** 只有服务端确认模板可用后才允许申请授权；不可用时由页面显示状态。 */
export function subscribeAvailable(kind = 'landed') {
  kindOrThrow(kind);
  return Boolean(template()) && Boolean(config.enabled) && supportedKinds.has(kind);
}

export function supportsNotificationKind(kind = 'landed') {
  kindOrThrow(kind);
  return serverConfigEnabled && supportedKinds.has(kind);
}

/**
 * 把 wx.requestSubscribeMessage 的回调结果翻译成可展示的状态。
 *
 * 三种失败要分开说，因为用户能做的处理完全不同：
 *   reject → 他自己点了拒绝，重试即可
 *   ban    → 模板已被平台封禁，不能说是用户关掉了开关
 *   其它   → 未知，让他重试
 */
export function classifySubscribeResult(res, templateId) {
  const v = res && res[templateId];
  if (v === 'accept') return { ok: true, status: 'accepted', reason: '' };
  if (v === 'reject') return { ok: false, status: 'rejected', reason: '你点了「拒绝」，没有订阅成功' };
  if (v === 'ban') {
    return { ok: false, status: 'banned', reason: '通知模板暂不可用，请稍后重试' };
  }
  if (v === 'filter') return { ok: false, status: 'filtered', reason: '通知模板未能授权，请稍后重试' };
  return { ok: false, status: 'unknown', reason: '授权没有生效，请重试' };
}

/** 走一次 wx.login 拿新 code（code 一次性，不能复用） */
function login() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (r) => (r && r.code ? resolve(r.code) : reject(new Error('wx.login 未返回 code'))),
      fail: (e) => reject(new Error((e && e.errMsg) || 'wx.login 失败')),
    });
  });
}

function requestSubscribe(templateId) {
  return new Promise((resolve, reject) => {
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: resolve,
      fail: (e) => reject(new Error((e && e.errMsg) || 'requestSubscribeMessage 失败')),
    });
  });
}

/**
 * 申请一次订阅并上报后端。
 * @returns {Promise<{ok:boolean, status:string, reason:string, synced?:boolean}>}
 */
export async function subscribeOnce(kind = 'landed') {
  kindOrThrow(kind);
  const authorizedTemplateId = template();
  if (!authorizedTemplateId) throw new Error('未配置订阅模板 ID');
  if (!config.enabled) throw new Error('联网已关闭，无法开启提醒');
  if (!subscribeAvailable(kind)) throw new Error('此类通知尚未就绪');

  const verdict = classifySubscribeResult(await requestSubscribe(authorizedTemplateId), authorizedTemplateId);
  if (!verdict.ok) return verdict;
  const grantId = newGrantId();
  const authorization = { templateId: authorizedTemplateId, grantId };
  pendingSync(true, kind, authorization);
  return syncSubscription(kind, authorization);
}

function newGrantId() {
  grantSequence++;
  return `grant-${Date.now().toString(36)}-${grantSequence.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 同步失败后的按钮只重试登记，不再次消耗一次微信授权。 */
export async function syncSubscription(kind = 'landed', authorization) {
  kindOrThrow(kind);
  const pending = pendingRecord(kind);
  const targetTemplateId = authorization?.templateId || pending?.templateId || template();
  const grantId = authorization?.grantId || pending?.grantId || '';
  if (!targetTemplateId) throw new Error('未配置订阅模板 ID');
  if (!authorization && pending && targetTemplateId !== template()) {
    pendingSync(false, kind, { templateId: pending.templateId, grantId: pending.grantId });
    return { ok: false, status: 'template-changed', reason: '通知模板已更新，请重新开启并授权。' };
  }
  if (targetTemplateId !== template() || !subscribeAvailable(kind)) {
    if (authorization && pending?.grantId === grantId) pendingSync(false, kind, { templateId: targetTemplateId, grantId });
    return { ok: false, status: 'template-changed', reason: '通知模板已更新，请重新开启并授权。' };
  }
  try {
    const code = await login();
    // 授权所用模板与登记模板必须相同；另一个通知类型的并发配置刷新不能替换它。
    if (targetTemplateId !== template()) {
      pendingSync(false, kind, { templateId: targetTemplateId, grantId });
      return { ok: false, status: 'template-changed', reason: '通知模板已更新，请重新开启并授权。' };
    }
    const result = await postJson('/api/subscribe', {
      code, templateId: targetTemplateId, kind,
      ...(grantId ? { grantId } : {}),
    });
    if (result.ok !== true || result.active !== true) throw new Error('服务器未确认开启，请重试同步');
    pendingSync(false, kind, { templateId: targetTemplateId, grantId });
    return { ok: true, status: 'accepted', synced: true };
  } catch (err) {
    if (err.statusCode === 422 && err.code === 'template_changed') {
      pendingSync(false, kind, { templateId: targetTemplateId, grantId });
      try { await loadSubscriptionConfig(); } catch {
        serverTemplateId = '';
        supportedKinds = new Set();
        serverConfigEnabled = false;
      }
      return { ok: false, status: 'template-changed', reason: '通知模板已更新，请重新开启并授权。' };
    }
    return { ok: true, status: 'accepted', synced: false, syncError: err.message };
  }
}

/** 退订。同样用 code 换 openid，客户端不传 openid；省略 kind 时兼容全退。 */
export async function unsubscribe(kind) {
  if (kind !== undefined) kindOrThrow(kind);
  const code = await login();
  return postJson('/api/unsubscribe', kind === undefined ? { code } : { code, kind });
}
