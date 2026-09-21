/**
 * F9 一次性订阅消息 —— 小程序端。
 *
 * 先说清楚这里的限制，因为它决定了整个交互的写法：
 *
 *   **一次授权 = 一次通知。** 长期订阅不对工具类目开放（政务 / 医疗 / 交通才有）。
 *   用户点一次「提醒我」，下次重置推一条，推完授权即消耗。
 *   要再收到，得重新进小程序再点一次。
 *
 * 所以入口文案必须说成「**下次重置提醒我一次**」，不能说「订阅通知」——
 * 后者会让用户以为一次授权就永久有效，那是我们误导了他。
 * 诱导连续授权（一次点按批十次）是微信明令禁止的，不做。
 *
 * 另一条：openid 由服务端用 code 换，客户端不碰 openid。code 是一次性的，
 * 因此**每次调用前都要重新 wx.login**，不能复用上一次的 code。
 */

import config from '../config.js';
import { postJson } from './api.js';

/** 入口文案：一次性限制写进按钮旁的说明，不靠用户猜 */
export const SCOPE_HINT = '一次授权只能收到一次通知，用完需要重新开启';
export const ACTION_LABEL = '下次重置时提醒我';
export const DONE_LABEL = '已开启（一次）';

/** 是否配置了模板 ID。没配就不显示入口，而不是显示一个点了没反应的按钮 */
export function subscribeAvailable() {
  return Boolean(config.subscribeTemplateId) && Boolean(config.enabled);
}

/**
 * 把 wx.requestSubscribeMessage 的回调结果翻译成可展示的状态。
 *
 * 三种失败要分开说，因为用户能做的处理完全不同：
 *   reject → 他自己点了拒绝，重试即可
 *   ban    → 他在微信里关掉了订阅消息总开关，得去设置里打开
 *   其它   → 未知，让他重试
 */
export function classifySubscribeResult(res, templateId) {
  const v = res && res[templateId];
  if (v === 'accept') return { ok: true, status: 'accepted', reason: '' };
  if (v === 'reject') return { ok: false, status: 'rejected', reason: '你点了「拒绝」，没有订阅成功' };
  if (v === 'ban') {
    return { ok: false, status: 'banned', reason: '订阅消息总开关被关掉了，请到微信「设置 → 订阅消息」里打开' };
  }
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
export async function subscribeOnce() {
  const templateId = config.subscribeTemplateId;
  if (!templateId) throw new Error('未配置订阅模板 ID');
  if (!config.enabled) throw new Error('联网已关闭，无法开启提醒');

  const verdict = classifySubscribeResult(await requestSubscribe(templateId), templateId);
  if (!verdict.ok) return verdict;

  // 授权拿到了。上报失败**不算订阅失败** —— 微信侧已经计入一次授权，
  // 说「失败」会让用户重复点，白白浪费他的次数。如实返回 synced:false 即可。
  try {
    const code = await login();
    await postJson('/api/subscribe', { code, templateId });
    return { ...verdict, synced: true };
  } catch (err) {
    return { ...verdict, synced: false, syncError: err.message };
  }
}

/** 退订。同样用 code 换 openid，客户端不传 openid */
export async function unsubscribe() {
  const code = await login();
  return postJson('/api/unsubscribe', { code });
}
