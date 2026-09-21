/**
 * 数据加载：**快照优先，接口覆盖**。
 *
 * 为什么不直接请求接口：
 *   request 合法域名必须 ICP 备案，配好之前所有请求都会 fail。
 *   如果首屏依赖接口，用户在小程序上线初期看到的就是白屏 —— 那是事故。
 *   所以内置快照（构建时生成）永远能出完整首屏，联网只是把它换成更新的数据。
 *
 * 三级降级：接口 → 本地缓存 → 内置快照。任何一级失败都不阻断渲染。
 */

import config from '../config.js';
import snapshot from '../data/snapshot.js';

const CACHE_KEY = 'tibo_state_v1';
const CACHE_TTL_MS = 30 * 60 * 1000; // 本地缓存超过 30 分钟就不再当新鲜数据用

let memo = null;

/* ------------------------------- 内置快照 ------------------------------- */

export function snapshotState() {
  return {
    chart: snapshot.chart,
    prediction: snapshot.prediction,
    signals: snapshot.signals,
    stats: snapshot.stats,
    account: snapshot.account,
    generatedAt: snapshot.generatedAt,
    dataUpdatedAt: snapshot.dataUpdatedAt,
    source: 'snapshot',
  };
}

/* -------------------------------- 请求 -------------------------------- */

/** 把 wx.request 的回调风格收成一个 Promise，GET / POST 共用 */
function send({ path, method, data }) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.apiBase.replace(/\/+$/, '') + path,
      method,
      data,
      timeout: config.timeoutMs,
      header: { 'content-type': 'application/json' },
      success(res) {
        const d = res.data;
        if (res.statusCode >= 200 && res.statusCode < 300 && d && typeof d === 'object' && !d.error) {
          resolve(d);
        } else {
          // 后端把失败原因写在 error / detail 里，别丢 —— 排查时它就是全部线索
          const why = (d && (d.detail || d.error)) || '';
          reject(new Error(`HTTP ${res.statusCode}${why ? ' · ' + why : ''}`));
        }
      },
      fail(err) {
        // 域名未加白名单时这里拿到的是 url not in domain list
        reject(new Error((err && err.errMsg) || 'request failed'));
      },
    });
  });
}

function request(path) {
  return send({ path, method: 'GET' });
}

/** POST JSON。F9 的订阅/退订走这里 */
export function postJson(path, data) {
  return send({ path, method: 'POST', data });
}

/* ------------------------------ 本地缓存 ------------------------------ */

function readCache() {
  try {
    const v = wx.getStorageSync(CACHE_KEY);
    if (!v || !v.at || !v.state) return null;
    if (Date.now() - v.at > CACHE_TTL_MS) return null;
    return { ...v.state, source: 'cache', cachedAt: v.at };
  } catch (e) {
    return null;
  }
}

function writeCache(state) {
  try {
    wx.setStorageSync(CACHE_KEY, {
      at: Date.now(),
      state: {
        chart: state.chart,
        prediction: state.prediction,
        signals: state.signals,
        stats: state.stats,
        account: state.account,
        generatedAt: state.generatedAt,
        dataUpdatedAt: state.dataUpdatedAt,
      },
    });
  } catch (e) {
    /* 存储写满或被禁用时忽略：缓存是优化，不是依赖 */
  }
}

/* -------------------------------- 主入口 -------------------------------- */

/**
 * 读取观测数据。
 * @param {object}  opts
 * @param {boolean} opts.force 忽略内存缓存，强制重新拉取
 * @returns {Promise<{state:object, degraded:boolean, reason:string|null}>}
 */
export async function loadState(opts = {}) {
  if (!opts.force && memo) return { state: memo, degraded: false, reason: null };

  if (!config.enabled) {
    const state = snapshotState();
    memo = state;
    return { state, degraded: true, reason: '联网已关闭，显示构建时快照' };
  }

  try {
    const remote = await request('/api/state');
    const state = {
      chart: remote.chart,
      prediction: remote.prediction,
      signals: remote.signals,
      stats: remote.stats,
      account: remote.account ?? snapshot.account,
      generatedAt: remote.generatedAt,
      dataUpdatedAt: remote.dataUpdatedAt,
      collectErrors: remote.collectErrors ?? [],
      source: 'api',
    };
    if (!state.chart || !state.prediction) throw new Error('接口返回缺少 chart / prediction');
    memo = state;
    writeCache(state);
    return { state, degraded: false, reason: null };
  } catch (err) {
    const cached = readCache();
    if (cached) {
      memo = cached;
      return { state: cached, degraded: true, reason: `联网失败（${err.message}），显示本地缓存` };
    }
    const state = snapshotState();
    memo = state;
    return { state, degraded: true, reason: `联网失败（${err.message}），显示内置快照` };
  }
}

export function clearMemo() {
  memo = null;
}
