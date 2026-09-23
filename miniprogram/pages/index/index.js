/**
 * 观测台首页。
 *
 * 渲染顺序是刻意的：**先出图，再联网**。
 *   1. onLoad 立刻用内置快照把首屏铺满（域名没备案也不会白屏）
 *   2. 后台拉接口，拿到就覆盖，拿不到就保留快照并明说「数据不是实时的」
 *   3. 计时器每秒更新滚动数字 —— 它只依赖时间戳，与网络无关
 */

import config from '../../config.js';
import { loadState, snapshotState } from '../../utils/api.js';
import { copyText } from '../../utils/clipboard.js';
import { buildGauge, buildSignal, buildMetrics, buildForecast } from '../../utils/view.js';
import { survivalScene, stripScene } from '../../utils/scene.js';
import { drawScene, setupCanvas } from '../../utils/draw.js';
import { countdown, countdownGroups, elapsed, reelGroups, verdict as makeVerdict, fmtDateTime, fmtClock, fmtClockSec } from '../../utils/format.js';
import {
  ACTION_LABEL,
  DONE_LABEL,
  SCOPE_HINT,
  subscribeAvailable,
  subscribeOnce,
} from '../../utils/subscribe.js';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** 本地记住「已开启一次提醒」。服务端不提供查询 —— 一次性订阅本来就不该有长期状态 */
const REMIND_KEY = 'tibo_remind_once_v1';

Page({
  data: {
    digits: DIGITS,
    counter: [],
    since: '',
    verdict: { cls: 'calm', text: '', tail: '' },
    metrics: [],
    signal: { show: false, checked: 0, lookback: 60 },
    forecast: null,
    survivalN: 0,
    updText: '',
    genText: '',
    account: 'thsottiaux',
    degraded: false,
    notice: '',
    remind: {
      show: false,
      title: '重置发生时提醒我',
      hint: SCOPE_HINT,
      label: '',
      state: 'idle',
      feedback: '',
      tone: '',
    },
  },

  onLoad() {
    this.ready = false;
    this.chart = null;
    this.lastAt = null;
    this._timer = null;
    this._painting = false;
    this._reminding = false;
    this.initRemind();
    // 首屏先铺内置快照，**不等网络** —— 接口回来再覆盖（见 utils/api.js 的三级降级）。
    //
    // ⚠ 这一句是「域名没配也不会白屏」这句承诺的真正落点，不能省：
    //   loadState 是「先 await 请求、再返回」的，只靠它兜底的话，接口慢或超时
    //   （timeoutMs 上限 8 秒）会先空着一整屏 —— 那正是这条设计要避免的事。
    this.apply({
      state: snapshotState(),
      degraded: true,
      reason: '正在获取最新数据，当前显示构建时快照',
    });
    this.load();
  },

  onReady() {
    this.ready = true;
    this.paint();
  },

  onShow() {
    this.startTicker();
    // 超过刷新间隔就静默刷新一次，避免用户切回来看到旧数据
    if (this._lastLoad && Date.now() - this._lastLoad > config.refreshIntervalMs) {
      this.load({ silent: true });
    }
  },

  onHide() {
    this.stopTicker();
  },

  onUnload() {
    this.stopTicker();
  },

  onPullDownRefresh() {
    this.load({ force: true }).then(() => wx.stopPullDownRefresh());
  },

  /* ------------------------------ 数据 ------------------------------ */

  load(opts = {}) {
    this._lastLoad = Date.now();
    return loadState({ force: !!opts.force })
      .then((r) => this.apply(r))
      .catch(() => {
        // loadState 内部已经把失败降级掉了，这里只兜底，避免下拉刷新卡住
        if (!opts.silent) wx.stopPullDownRefresh();
      });
  },

  apply({ state, degraded, reason }) {
    const chart = state.chart;
    const lastAt = chart ? new Date(chart.lastAt).getTime() : null;
    const genTs = state.generatedAt ? new Date(state.generatedAt).getTime() : Date.now();

    this.chart = chart;
    this.lastAt = lastAt;
    // 换了一批数据，倒计时的去重键必须作废 —— 否则新窗口的第一秒不会渲染
    this._cdKey = null;

    this.setData(
      {
        metrics: buildMetrics(chart),
        signal: buildSignal(state.signals),
        gauge: buildGauge(chart),
        forecast: buildForecast(state.prediction),
        survivalN: chart ? chart.gapDays.length : 0,
        genText: fmtDateTime(genTs),
        // 「观测中」后面是**当前北京时间**，由 tick 每秒推进（见 tick）。
        // 降级态是例外：那时要传达的正是「这是什么时候的快照」，显示数据时刻才有信息量。
        updText: degraded ? `快照 · ${fmtClock(genTs)}` : `观测中 · ${fmtClockSec(Date.now())}`,
        account: state.account || 'thsottiaux',
        degraded: !!degraded,
        notice: degraded ? reason || '当前展示的不是实时数据' : '',
        since: lastAt ? `上次重置 ${fmtDateTime(lastAt)} · ${this.sinceText(lastAt)}` : '',
        verdict: makeVerdict(chart ? chart.pct : 0),
      },
      () => {
        this.tick();
        this.paint();
      }
    );
  },

  sinceText(lastAt) {
    const el = elapsed(lastAt);
    return el.d < 1 ? '已过不足一天' : `已过 ${el.d} 天`;
  },

  /* ------------------------------ 滚动计时 ------------------------------ */

  startTicker() {
    this.stopTicker();
    if (!this.lastAt) this.tick();
    this._timer = setInterval(() => this.tick(), 1000);
  },

  stopTicker() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  tick() {
    const now = Date.now();
    const patch = {};

    if (this.lastAt) {
      const groups = reelGroups(elapsed(this.lastAt, now));
      // 只在数字真的变了才 setData：秒位每秒都变，但天/时/分不动时
      // 把它们一起重发会让 4 组卷轴全部重排，白白掉帧
      const sig = groups.map((g) => g.digits.join('')).join('|');
      if (sig !== this._sig) {
        this._sig = sig;
        patch.counter = groups;
      }
    }

    const cd = this.tickCountdown(now);
    if (cd) patch['signal.cd'] = cd;

    // 「观测中」后面是当前北京时间，跟着时钟走。降级态不参与 ——
    // 那时显示的是快照时刻，是个固定值。
    if (!this.data.degraded) {
      const t = fmtClockSec(now);
      if (t !== this._upd) {
        this._upd = t;
        patch.updText = '观测中 · ' + t;
      }
    }

    if (Object.keys(patch).length) this.setData(patch);
  },

  /**
   * 预告窗口的倒计时，与主计数共用同一次 tick —— 不额外开定时器。
   * 同样只在「秒」真的变了才 setData，避免整块横幅跟着重排。
   */
  tickCountdown(now) {
    const s = this.data.signal;
    const fromTs = s && s.window && s.window.fromTs;
    if (!fromTs) return null;

    const cd = countdown(fromTs, now);
    const key = cd.over ? 'over' : `${cd.d}:${cd.h}:${cd.m}:${cd.s}`;
    if (key === this._cdKey) return null;
    this._cdKey = key;

    return {
      over: cd.over,
      groups: countdownGroups(cd),
      // 窗口开了就不再报读数，只报状态 —— 与网页端 .sig-cd[data-over="1"] 同一口径。
      // 文案也跟网页端对齐（此前写「距预告窗口开启」，两端不一致）。
      label: cd.over ? '窗口已开启 · 随时可能重置' : '距窗口开启',
    };
  },

  /* ------------------------------ 图表 ------------------------------ */

  async paint() {
    if (!this.ready || !this.chart || this._painting) return;
    this._painting = true;
    const chart = this.chart;
    try {
      const surv = await setupCanvas(this, '#survival');
      if (surv) {
        drawScene(
          surv.ctx,
          survivalScene(chart, {
            layout: 'compact',
            width: Math.round(surv.width),
            height: Math.round(surv.height),
          }),
          surv.dpr
        );
      }

      const strip = await setupCanvas(this, '#strip');
      if (strip) {
        drawScene(
          strip.ctx,
          stripScene(chart, {
            layout: 'compact',
            width: Math.round(strip.width),
            height: Math.round(strip.height),
          }),
          strip.dpr
        );
      }
    } catch (e) {
      // canvas 2d 不可用时页面其余部分照常可用，只是没有图
      console.warn('图表绘制失败：', e && e.message);
    } finally {
      this._painting = false;
    }
  },

  /* ------------------------------ F9 一次性提醒 ------------------------------ */

  initRemind() {
    let on = false;
    try {
      on = Boolean(wx.getStorageSync(REMIND_KEY));
    } catch (e) {
      on = false; // 存储不可用就按未开启处理：提醒是增强，不该拖垮首屏
    }
    this.setRemind({
      show: subscribeAvailable(),
      label: on ? DONE_LABEL : ACTION_LABEL,
      state: on ? 'on' : 'idle',
      // 上一次的结果提示不该跟着重来一遍
      feedback: '',
      tone: '',
    });
  },

  /** 整对象 setData：路径写法在部分基础库上对嵌套字段支持不一致，不值得赌 */
  setRemind(patch) {
    this.setData({ remind: Object.assign({}, this.data.remind, patch) });
  },

  onToggleRemind() {
    if (this._reminding) return;
    this._reminding = true;
    this.setRemind({ feedback: '', tone: '' });
    wx.showLoading({ title: '正在开启…', mask: true });

    // 返回这条链，调用方（含测试）await 它才能等到真正结束
    return subscribeOnce()
      .then((r) => {
        if (!r.ok) {
          // 明确没拿到授权（拒绝 / 总开关被关）→ 本机标记一并清掉。
          // 这个标记记的是「最近一次操作的结果」，不是永久状态：
          // 一次性授权推完就消耗了，客户端无从得知，所以宁可少报也不多报「已开启」。
          try {
            wx.removeStorageSync(REMIND_KEY);
          } catch (e) {
            /* 清理失败不影响这次提示 */
          }
          this.setRemind({ label: ACTION_LABEL, state: 'idle', feedback: r.reason, tone: 'warn' });
          return;
        }
        try {
          wx.setStorageSync(REMIND_KEY, Date.now());
        } catch (e) {
          /* 存不下也要把状态显示对，否则用户会以为没成功又点一次 */
        }
        this.setRemind({
          label: DONE_LABEL,
          state: 'on',
          tone: r.synced ? 'ok' : 'warn',
          feedback: r.synced
            ? '已开启。下次额度重置会推送一条通知，推完需要重新开启。'
            : `授权已生效，但同步到服务器失败（${r.syncError}）。下次重置可能收不到通知。`,
        });
      })
      .catch((err) => this.setRemind({ feedback: (err && err.message) || '开启失败，请重试', tone: 'warn' }))
      .then(() => {
        // 复位重入锁。不复位的话，任何一次异常之后这个按钮就永久失效了 ——
        // 用户看到的是「点了没反应」，且没有任何提示能解释为什么。
        this._reminding = false;
        wx.hideLoading();
      });
  },

  /* ------------------------------ 交互 ------------------------------ */

  /**
   * 展开/收起「依据 N 条推文」。
   *
   * ⚠ 只 setData 打开状态，**不重算 evidence** —— 列表随 signal 一起下发过了，
   *   重算会把每秒都在 ticking 的横幅整块触发重排。
   */
  onToggleEv() {
    const s = this.data.signal;
    if (!s || !s.evCount) return;
    this.setData({ 'signal.evOpen': !s.evOpen });
  },

  /**
   * 复制原推链接。优先用条目自己的 `data-url`（预告里每条推文各有一个链接），
   * 回退到横幅的主链接（线索档只有一条推文，链接挂在横幅上）。
   *
   * 个人主体小程序不能用 web-view，所以外链只能复制出去让用户在浏览器打开。
   * `setClipboardData` 是隐私接口（微信归在「读取你的剪切板」条目下），
   * 拒绝授权时不会走 success —— 兜底与文案统一在 utils/clipboard.js。
   */
  onCopySource(e) {
    const fromItem = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.url;
    const url = fromItem || (this.data.signal && this.data.signal.url);
    copyText(url);
  },
});
