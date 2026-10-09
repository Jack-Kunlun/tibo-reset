/**
 * 小程序入口。
 *
 * 数据预热与代码包更新都不阻塞首屏；真正的渲染在页面里。
 */

import { loadState } from './utils/api.js';
import { isSinglePage } from './utils/share.js';
import { createUpdatePrompt } from './utils/update.js';

App({
  globalData: {
    /** 最近一次加载结果，供页面之间复用，避免重复请求 */
    state: null,
    degraded: false,
    reason: null,
  },

  onLaunch() {
    this._updatePrompt = createUpdatePrompt();
    this.warmup();
  },

  onShow() {
    this._updatePrompt?.onShow(!isSinglePage());
  },

  onHide() {
    this._updatePrompt?.onHide();
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
