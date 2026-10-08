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
import { indexShareTitle, isSinglePage } from '../../utils/share.js';
import { buildGauge, buildSignal, buildMetrics, buildForecast, buildOutlookView, predCountdown } from '../../utils/view.js';
import { survivalScene, stripScene, histogramScene } from '../../utils/scene.js';
import { drawScene, setupCanvas } from '../../utils/draw.js';
import { elapsed, fmtSpan, reelGroups, verdict as makeVerdict, fmtDateTime, fmtClock, fmtClockSec, toTs } from '../../utils/format.js';
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
    signal: { show: false, checked: 0, lookback: 60, program: { show: false } },
    /** 预测总览（带推断的那块）。null = 数据不足，模板据此整块不渲染，而不是画一张空卡 */
    pred: null,
    forecast: null,
    /** 直方图有没有数据 —— 没有就不渲染 canvas（`setupCanvas` 找不到节点会静默返回 null） */
    histShow: false,
    survivalN: 0,
    updText: '',
    genText: '',
    account: 'thsottiaux',
    degraded: false,
    notice: '',
    /** 分享到朋友圈的单页模式：禁用的组件/接口要在模板里让位（见 utils/share.js） */
    singlePage: false,
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
    // 单页模式判断要**在 initRemind 之前**完成 —— 它决定 F9 入口显不显示
    // （单页模式无登录态，wx.login 不可用，提醒链路整条走不通）。
    this.setData({ singlePage: isSinglePage() });
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

    // 预测总览的**锚点**：取预测自己的 `asOf`，不用 `Date.now()`。
    // `q50` 是按 `asOf` 那一刻算出来的，换个时刻当锚点就会得到另一个 ETA ——
    // 而卡里「预测算于 X」写的就是锚点本身，两处对不上比数字旧更糟。
    // 快照态的 `generatedAt` 与 `asOf` 同源（构建时用的是同一个 now），拿它兜底。
    const anchor = toTs(state.prediction && state.prediction.asOf);
    const predNow = Number.isFinite(anchor) ? anchor : genTs;

    this.chart = chart;
    this.lastAt = lastAt;
    // 换了一批数据，倒计时的去重键必须作废 —— 否则新窗口的第一秒不会渲染
    this._pcdKey = null;

    // 预测总览先算出来，随后的依据卡要读它的 `checks`（三项判据）与 `evidence`
    // （阈值 / 重采样波动）——「过没过」只能有一份来源，所以这个顺序不能反。
    const outlook = buildOutlookView(chart, state.prediction, state.signals, predNow);

    this.setData(
      {
        metrics: buildMetrics(chart),
        signal: buildSignal(state.signals),
        gauge: buildGauge(chart),
        pred: outlook,
        // 直方图有没有东西可画。`total` 为 0 时不着 canvas —— 空白画布比没有画布更像故障
        histShow: Boolean(chart && chart.hist && chart.hist.total),
        forecast: buildForecast(state.prediction, outlook),
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
    // 不足一天时给到「小时 + 分」，不再只写「已过不足一天」——
    // 那句话在「已过 20 小时」和「已过 10 分钟」两种情形下一模一样，信息量为零。
    return `已过 ${fmtSpan(el.ms / 86400000)}`;
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

    const pcd = this.tickPredCountdown(now);
    if (pcd) patch['pred.cd'] = pcd;

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
   * 预测总览的大倒计时，与别处共用同一次 tick —— 不额外开定时器。
   *
   * 这是全页**唯一**往前看的读数。信号区此前也有一个「距窗口开启」的倒数
   * （数的是公告窗口开启时刻），但那与主卡在公告档下是**同一时刻**，
   * 两个同值的大数字叠在首屏上只会互相稀释 —— 已删，信号区只讲
   * 「他说了什么、原文在哪」。窗口开启时刻仍由 .win 块以「北京时间 ⋯ 起」给出。
   *
   * 文案（含过点后分档的那句）在 `utils/view.js` 的 `predCountdown` 里，
   * 与本地预览脚本共用一份 —— 那句措辞有两份实现，预览就会与真机不一致。
   * 这里只管「同一秒不重复 setData」。
   */
  tickPredCountdown(now) {
    const cd = predCountdown(this.data.pred, now);
    if (!cd) return null;

    const key = cd.over ? 'over' : cd.groups.map((g) => g.v).join(':');
    if (key === this._pcdKey) return null;
    this._pcdKey = key;
    return cd;
  },

  /* ------------------------------ 图表 ------------------------------ */

  async paint() {
    if (!this.ready || !this.chart || this._painting) return;
    this._painting = true;
    const chart = this.chart;
    try {
      // 顺序与页面顺序一致（直方图 → 生存曲线 → 点阵）。三张图共用同一个
      // `drawScene`，没有各自的分支 —— 图元类型只有 line / circle / poly / text。
      const hist = await setupCanvas(this, '#hist');
      if (hist) {
        drawScene(
          hist.ctx,
          histogramScene(chart, {
            layout: 'compact',
            width: Math.round(hist.width),
            height: Math.round(hist.height),
          }),
          hist.dpr
        );
      }

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
      // 单页模式下不给入口：`subscribeOnce` 第一步是 wx.login 换 code，
      // 而单页模式没有登录态，点了必然失败 —— 宁可没有入口，
      // 也不摆一个点下去只会弹错的按钮（同 subscribeTemplateId 为空时的处理）。
      show: subscribeAvailable() && !this.data.singlePage,
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
  /**
   * 提示条（「最近 N 条推文中没有检测到重置预告」）的落点。
   *
   * 它指向「已经等了多久」那一块 —— 没有预告时，读者下一个该看的正是那个数字
   * （等了多久、在历史里算什么位置）。网页端是同一条信息走 `href="#elapsed"`；
   * 小程序没有锚点链接，只能量出位置再滚过去。
   *
   * ⚠ 用 `exec()` 的**结果数组**一次取回矩形与滚动量，不要写在两个回调里各读一次 ——
   *   `boundingClientRect` 的回调先执行，那时 `scrollOffset` 的结果还没到手，
   *   拿到的是上一轮的值（首次点击时就是 0），算出来的目标位置会偏一屏。
   */
  onIdleTap() {
    wx.createSelectorQuery()
      .select('#elapsed')
      .boundingClientRect()
      .selectViewport()
      .scrollOffset()
      .exec((res) => {
        const rect = res && res[0];
        const scroll = res && res[1];
        if (!rect) return;
        const top = rect.top + ((scroll && scroll.scrollTop) || 0) - 16;
        wx.pageScrollTo({ scrollTop: Math.max(0, top), duration: 240 });
      });
  },

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

  /* ------------------------------ 分享 ------------------------------ */

  /**
   * 发送给朋友。
   *
   * **定义了它，右上角菜单才出现「转发」**（官方文档原话），不定义则整个分享
   * 入口都不存在。这也是「分享到朋友圈」的前置条件 —— 官方要求页面先支持
   * 「发送给朋友」，才允许被分享到朋友圈。
   *
   * 不传 `imageUrl`，走微信的**默认截图**。这是刻意选的：
   *   · 网页端的 `dist/og-image.png` 是 1200×630（比例 1.905），而小程序分享图
   *     是 5:4（1.25）—— 比例差得远，直接复用会被裁成中间一条。
   *   · 改用网络图要额外配 `downloadFile` 合法域名，等于再添一处「没配就静默
   *     失败」的地方（和 request 域名同类问题，不弹错、最难查）。
   *   · 默认截图截到的正是品牌区 + 当前状态，对这一页反而最贴切。
   */
  onShareAppMessage() {
    return {
      title: this.shareTitle(),
      path: '/pages/index/index',
    };
  },

  /**
   * 分享到朋友圈（基础库 2.11.3+）。
   *
   * ⚠ **不支持自定义页面路径**（官方限制），所以这里只有 title —— 朋友圈点开的
   *   必然是当前这一页，也正因为如此，页面必须自己适配单页模式（见 share.js）。
   *
   * ⚠ 这个入口能不能出现，还取决于小程序在后台是否具备该能力（与微信认证状态
   *   有关，代码侧判断不了）。不具备时按钮不出现而已、不会报错，所以两处都写上
   *   不亏：缺的那半边不影响「发送给朋友」。
   *
   * ⚠ 不要为此去调 `wx.showShareMenu({menus:[...]})`：那个 `menus` 参数官方标注
   *   为 Beta 且**暂只 Android 支持**，定义了本函数才是跨平台生效的判据。
   */
  onShareTimeline() {
    return { title: this.shareTitle() };
  },

  /** 两处分享共用同一份标题，避免同一页在「发好友」与「发朋友圈」里说法不一致 */
  shareTitle() {
    return indexShareTitle({ signal: this.data.signal, lastAt: this.lastAt });
  },
});
