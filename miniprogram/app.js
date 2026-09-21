/**
 * 小程序入口。
 *
 * 这里只做一件事：预热数据。真正的渲染在页面里，
 * 因为首屏必须**先出图再联网**，不能等网络。
 */

import { loadState } from './utils/api.js';

App({
  globalData: {
    /** 最近一次加载结果，供页面之间复用，避免重复请求 */
    state: null,
    degraded: false,
    reason: null,
  },

  onLaunch() {
    this.warmup();
  },

  /** 预取一次数据，失败也不抛（页面自己还有回落路径） */
  warmup() {
    loadState()
      .then((r) => {
        this.globalData.state = r.state;
        this.globalData.degraded = r.degraded;
        this.globalData.reason = r.reason;
      })
      .catch(() => {});
  },
});
