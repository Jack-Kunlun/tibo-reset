/**
 * 三个 Tab 复用数据加载与生命周期，预测与提醒仍只有一份实现。
 *
 * 渲染顺序是刻意的：**先出图，再联网**。
 *   1. onLoad 立刻用内置快照把首屏铺满（域名没备案也不会白屏）
 *   2. 后台拉接口，拿到就覆盖，拿不到就保留快照并明说「数据不是实时的」
 *   3. 计时器每秒更新滚动数字 —— 它只依赖时间戳，与网络无关
 */

import config from '../config.js';
import { loadState, snapshotState } from './api.js';
import { copyText } from './clipboard.js';
import { indexShareTitle, historyShareTitle, isSinglePage } from './share.js';
import { buildGauge, buildSignal, buildMetrics, buildForecast, buildOutlookView, buildCalendarView, buildProgramPlanView, buildObservationSignal, buildTodayResetView, predCountdown, readoutParts } from './view.js';
import { survivalScene, stripScene, histogramScene, rhythmScene } from './scene.js';
import { drawScene, setupCanvas } from './draw.js';
import { elapsed, reelGroups, verdict as makeVerdict, fmtDateTime, fmtClock, fmtClockSec, fmtSpan, toTs, beijingParts } from './format.js';
import {
  ACTION_LABELS,
  DONE_LABELS,
  SCOPE_HINT,
  subscribeAvailable,
  supportsNotificationKind,
  supportsBatchSubscription,
  subscribeKinds,
  subscribeOnce,
  loadSubscriptionConfig,
  subscriptionStatus,
  hasPendingSync,
  syncSubscription,
} from './subscribe.js';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

function navigationLayout(singlePage = false) {
  let info = {};
  let menu = null;
  try {
    info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
  } catch (e) {
    info = {};
  }
  try {
    menu = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null;
  } catch (e) {
    menu = null;
  }
  const width = Number(info && (info.windowWidth || info.screenWidth)) || 375;
  const statusBarHeight = Number(info && info.statusBarHeight) || 20;
  const menuLeft = Number(menu && menu.left);
  const menuBottom = Number(menu && menu.bottom);
  const validMenuLeft = Number.isFinite(menuLeft) && menuLeft > 0 && menuLeft < width;
  const validMenuBottom = Number.isFinite(menuBottom) && menuBottom > statusBarHeight;
  const validMenuRect = validMenuLeft && validMenuBottom;
  const capsuleReserve = validMenuRect ? Math.max(0, width - menuLeft + 10) : 96;
  const capsuleHeight = validMenuRect ? Math.max(0, menuBottom - statusBarHeight + 6) : 44;
  return {
    // 朋友圈单页模式自带顶部安全空间；custom 导航下不能再把状态栏/胶囊留白叠一遍。
    statusBarHeight: singlePage ? 0 : statusBarHeight,
    capsuleReserve: singlePage ? 0 : capsuleReserve,
    brandHeight: singlePage ? 44 : Math.max(44, capsuleHeight),
  };
}

function recordRows(chart) {
  const records = Array.isArray(chart && chart.records) ? chart.records : [];
  return records
    .slice()
    .reverse()
    .map((r, i) => {
      const ts = toTs(r && r.at);
      return {
        key: (r && r.id) || (r && r.at) || `record-${i}`,
        date: Number.isFinite(ts) ? fmtDateTime(ts).slice(5) : '时间未知',
        fullDate: Number.isFinite(ts) ? fmtDateTime(ts) : '时间未知',
        monthDay: Number.isFinite(ts) ? fmtDateTime(ts).slice(5, 10) : '—',
        year: Number.isFinite(ts) ? fmtDateTime(ts).slice(0, 4) : '',
        time: Number.isFinite(ts) ? fmtClock(ts) : '—',
        summary: String(r?.text || '').split('\n')[0].slice(0, 45),
        type: r && r.type === 'credit' ? '发券型' : '额度重置',
        text: (r && r.text) || '',
        translation: r?.translation?.language === 'zh-CN' ? r.translation.text : '',
        url: (r && r.url) || '',
      };
    });
}

function trendRows(chart) {
  const gaps = Array.isArray(chart && chart.gapDays) ? chart.gapDays : [];
  const records = Array.isArray(chart && chart.records) ? chart.records : [];
  const start = Math.max(0, gaps.length - 7);
  return gaps.slice(start).map((value, i) => {
    const record = records[start + i + 1];
    const ts = toTs(record && record.at);
    return {
      value: Number(value),
      label: Number.isFinite(ts) ? fmtDateTime(ts).slice(5, 10) : '',
    };
  }).filter((point) => Number.isFinite(point.value) && point.value >= 0);
}

function basisRows(pred, forecast) {
  if (pred?.arrivalRows) return pred.arrivalRows.map((row) => ({ ...row, parts: readoutParts(row.value) }));
  if (!pred || !forecast || !forecast.backtest) return [];
  const coverage = (forecast.backtest.rows || []).find((row) => row.k === '80% 区间覆盖率');
  const phaseRows = forecast.pace && Array.isArray(forecast.pace.phases) ? forecast.pace.phases : [];
  const recentPhase = phaseRows.length ? phaseRows[phaseRows.length - 1] : null;
  const announcement = pred.briefData || {};
  const announced = pred.etaKind === 'announced';
  const announcementParts = [];
  if (announcement.announcedHard > 0) announcementParts.push(`${announcement.announcedHard} 条硬承诺`);
  if (announcement.announcedSoft > 0) announcementParts.push(`${announcement.announcedSoft} 条同日提及`);
  return [
    {
      key: 'source',
      label: announced ? '公告依据' : '历史推算',
      value: announced
        ? announcementParts.join(' · ') || '公告窗口已确认'
        : `${Number.isFinite(announcement.intervals) ? announcement.intervals : '—'} 次间隔`,
    },
    {
      key: 'coverage',
      label: '80% 区间覆盖率',
      value: coverage ? coverage.v : '—',
    },
    {
      key: 'pace',
      label: '近期平均间隔',
      value: recentPhase ? `${recentPhase.mean}${recentPhase.unit.replace(/\s+/g, '')}` : '—',
    },
  ].map((row) => ({ ...row, parts: readoutParts(row.value) }));
}


function calendarSelection(calendar, date) {
  const cell = calendar?.cells.find((item) => item.date === date);
  if (!cell) return null;
  return {
    date: cell.date.replace(/-/g, '.'),
    label: `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8))} 日 · 周${'日一二三四五六'[new Date(date + 'T00:00:00Z').getUTCDay()]}`,
    status: cell.status,
    statusLabel: cell.statusLabel,
    details: (cell.details || []).map((detail, index) => ({
      key: String(detail.id || `${date}-${index}`),
      title: detail.roles.includes('observed') ? '已有账号实测到账'
        : detail.roles.includes('confirmed') ? detail.type === 'credit' ? '发券型已确认' : '重置已确认'
        : detail.roles.includes('forecast') ? detail.awaitingVerification ? '预告窗口已结束 · 落地待核实' : '明确预告 · 尚未确认落地'
        : detail.roles.includes('updated') ? '功能更新' : '原帖',
      when: detail.roles.includes('observed')
        ? `${detail.observationPrecision === 'approximate-minute' ? '约' : ''}${Number.isFinite(toTs(detail.observedAt)) ? fmtDateTime(toTs(detail.observedAt)) + ' 北京' : '时间未知'} · ${detail.sourceLabel || '账号实测'} · 仅代表单个账号`
        : `${detail.timePrecision === 'approximate-minute' ? '约' : ''}${fmtDateTime(toTs(detail.confirmedAt || detail.createdAt))} 北京${detail.manual ? ' · 手动补录' : ''}`,
      time: fmtClock(toTs(detail.roles.includes('observed') ? detail.observedAt : detail.confirmedAt || detail.createdAt)),
      text: detail.text || '',
      translation: detail.translation?.language === 'zh-CN' ? detail.translation.text : '',
      url: detail.url || '',
    })),
  };
}

function planSelection(planView, day) {
  if (!planView?.show || !Number.isInteger(Number(day))) return null;
  return planView.days.find((row) => row.day === Number(day)) || null;
}

export function createDashboardPage(view = 'observe') {
  return {
  data: {
    view,
    pageTitle: view === 'records' ? '每一次，都有记录' : view === 'analysis' ? '预测的依据' : '捕捉下一次重置',
    pageEyebrow: view === 'records' ? 'RESET JOURNAL' : view === 'analysis' ? 'BEHIND THE ESTIMATE' : "TODAY'S OUTLOOK",
    allRecords: [],
    selectedDate: '',
    selectedDay: null,
    recordCount: 0,
    mean: '',
    arrival: null,
    elapsedGroups: [],
    expandedRecord: '',
    todayLabel: '',
    todayReset: null,
    signalAge: '',
    elapsedLabel: '距上次重置',
    accountObservationText: '',
    trendBars: [],
    medianDays: '',
    analysisTitle: '',
    analysisOpen: { wait: false, backtest: false, pace: false, history: false, samples: false, arrival: false },
    digits: DIGITS,
    counter: [],
    since: '',
    lastResetText: '',
    verdict: { cls: 'calm', text: '', tail: '' },
    metrics: [],
    signal: { show: false, checked: 0, lookback: 60, program: { show: false } },
    /** 预测总览（带推断的那块）。null = 数据不足，模板据此整块不渲染，而不是画一张空卡 */
    pred: null,
    forecast: null,
    /** 直方图有没有数据 —— 没有就不渲染 canvas（`setupCanvas` 找不到节点会静默返回 null） */
    histShow: false,
    survivalN: 0,
    basisRows: [],
    calendar: null,
    planView: { show: false, days: [] },
    selectedPlanDay: 0,
    selectedPlan: null,
    expandedPlanEntry: '',
    calendarRange: '',
    trend: [],
    trendCount: 0,
    trendFirst: '',
    trendLast: '',
    recentRecords: [],
    moreRecords: [],
    moreRecordsCount: 0,
    moreRecordsOpen: false,
    detailsOpen: false,
    programOpen: false,
    programHeight: 0,
    signalDetailsOpen: false,
    motionEnabled: true,
    pageVisible: false,
    nav: { statusBarHeight: 20, capsuleReserve: 96, brandHeight: 44 },
    entering: false,
    ripple: { show: false, x: 0, y: 0 },
    updText: '',
    genText: '',
    dataText: '',
    account: 'thsottiaux',
    degraded: false,
    notice: '',
    /** 分享到朋友圈的单页模式：禁用的组件/接口要在模板里让位（见 utils/share.js） */
    singlePage: false,
    announcementRemind: { show: false, hint: SCOPE_HINT, label: '', state: 'checking', feedback: '', tone: '' },
    landedRemind: { show: false, hint: SCOPE_HINT, label: '', state: 'checking', feedback: '', tone: '' },
    reminderBatch: false,
    reminderAction: { label: '检查中…', disabled: true, loading: false },
  },

  onLoad() {
    this.ready = false;
    this.chart = null;
    this.lastAt = null;
    this._timer = null;
    this._painting = false;
    this._paintAgain = false;
    this._programMeasure = 0;
    this._remindingKinds = new Set();
    this._rippleTimer = null;
    this._hasShown = false;
    // 单页模式判断要**在 initRemind 之前**完成 —— 它决定 F9 入口显不显示
    // （单页模式无登录态，wx.login 不可用，提醒链路整条走不通）。
    const singlePage = isSinglePage();
    this.setData({ singlePage, pageVisible: false, nav: navigationLayout(singlePage) });
    if (view === 'observe') this.initRemind();
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
    const singlePage = isSinglePage();
    const changedScene = singlePage !== !!this.data.singlePage;
    this.setData({ singlePage, nav: navigationLayout(singlePage), pageVisible: true, entering: !this._hasShown && this.data.motionEnabled });
    if (view === 'observe' && changedScene) {
      // 页面可被复用；单页模式切换时不能沿用上个入口的授权状态和待返回结果。
      this._remindRevisions = { announcement: (this._remindRevisions?.announcement || 0) + 1,
        landed: (this._remindRevisions?.landed || 0) + 1 };
      this.initRemind();
    }
    this._hasShown = true;
    this.startTicker();
    if (view === 'observe' && !singlePage) this.refreshReminders();
    // 每次切回都接收共享缓存的新结果；超过刷新间隔才强制联网。
    if (view === 'analysis') this.paint();
    if (this._lastLoad) {
      this.load({ silent: true, force: Date.now() - this._lastLoad > config.refreshIntervalMs });
    }
  },

  onHide() {
    this.stopTicker();
    this.clearRippleTimer();
    this.setData({ pageVisible: false, signalDetailsOpen: false, entering: false, ripple: { show: false, x: 0, y: 0 } });
  },

  onUnload() {
    this.stopTicker();
    this.clearRippleTimer();
    this._programMeasure++;
  },

  onPullDownRefresh() {
    return Promise.all([
      view === 'observe' ? this.refreshReminders() : Promise.resolve(),
      this.load({ force: true }),
    ]).finally(() => wx.stopPullDownRefresh());
  },

  /* ------------------------------ 数据 ------------------------------ */

  load(opts = {}) {
    if (this._loading) return this._loading;
    this._lastLoad = Date.now();
    this._loading = loadState({ force: !!opts.force })
      .then((r) => this.apply({ ...r, preserveUi: !!opts.silent }))
      .catch(() => {
        // loadState 内部已经把失败降级掉了，这里只兜底，避免下拉刷新卡住
        if (!opts.silent) wx.stopPullDownRefresh();
      }).finally(() => { this._loading = null; });
    return this._loading;
  },

  apply({ state, degraded, reason, preserveUi = false }) {
    const chart = state.chart;
    const currentNow = Date.now();
    const lastAt = chart ? toTs(chart.lastAt) : null;
    const parsedGenTs = toTs(state.generatedAt);
    const genTs = Number.isFinite(parsedGenTs) ? parsedGenTs : currentNow;

    // 预测总览的**锚点**：取预测自己的 `asOf`，不用 `Date.now()`。
    // `q50` 是按 `asOf` 那一刻算出来的，换个时刻当锚点就会得到另一个 ETA ——
    // 而卡里「预测算于 X」写的就是锚点本身，两处对不上比数字旧更糟。
    // 快照态的 `generatedAt` 与 `asOf` 同源（构建时用的是同一个 now），拿它兜底。
    const anchor = toTs(state.prediction && state.prediction.asOf);
    const predNow = Number.isFinite(anchor) ? anchor : genTs;

    this.chart = chart;
    this.lastAt = lastAt;
    this.trend = trendRows(chart);
    // 换了一批数据，倒计时的去重键必须作废 —— 否则新窗口的第一秒不会渲染
    this._pcdKey = null;

    // 预测总览先算出来，随后的依据卡要读它的 `checks`（三项判据）与 `evidence`
    // （阈值 / 重采样波动）——「过没过」只能有一份来源，所以这个顺序不能反。
    const outlook = buildOutlookView(chart, state.prediction, state.signals, predNow);
    const forecast = buildForecast(state.prediction, outlook);
    const records = recordRows(chart);
    const calendar = buildCalendarView(state.signals?.calendar);
    const rawPlan = state.signals?.calendar?.plan;
    const planView = buildProgramPlanView(rawPlan && {
      ...rawPlan,
      source: rawPlan.source || (state.source === 'snapshot' || calendar?.source === 'snapshot'
        ? 'snapshot' : state.source === 'cache' ? 'cache' : 'api'),
      // preview-miniprogram 也有真实成功采集时刻；不回退到生成/请求时间。
      dataAsOf: rawPlan.dataAsOf ?? state.dataUpdatedAt,
    });
    const selectedPlanDay = preserveUi && planView?.days?.some((row) => row.day === this.data.selectedPlanDay)
      ? this.data.selectedPlanDay : planView?.latestDay > 0 ? planView.latestDay : 0;
    const selectedPlan = planSelection(planView, selectedPlanDay);
    const expandedPlanEntry = preserveUi && selectedPlan?.entries.some((entry) => entry.key === this.data.expandedPlanEntry)
      ? this.data.expandedPlanEntry : '';
    const selectedDate = preserveUi && calendar?.cells.some((cell) => cell.date === this.data.selectedDate)
      ? this.data.selectedDate : calendar?.cells.filter((cell) => cell.confirmedCount).slice(-1)[0]?.date || calendar?.cells.find((cell) => cell.isToday)?.date || '';
    const delay = state.prediction?.announcementDelay;
    const arrival = delay?.sampleCount ? { count: delay.sampleCount,
      median: Number.isFinite(delay.medianMs) ? fmtSpan(delay.medianMs / 86400000) : '样本不足',
      range: Number.isFinite(delay.minMs) && Number.isFinite(delay.maxMs)
        ? `${fmtSpan(delay.minMs / 86400000)} — ${fmtSpan(delay.maxMs / 86400000)}` : '—' } : null;
    const signal = view === 'observe' ? buildObservationSignal(state.signals, lastAt, predNow) : buildSignal(state.signals);
    const published = toTs(signal.createdAt);
    const ageMinutes = Number.isFinite(published) ? Math.max(0, Math.floor((Date.now() - published) / 60000)) : null;
    const latestObservation = state.signals?.latestAccountObservation;
    const observedAt = toTs(latestObservation?.observedAt);
    const hasNewerAccountObservation = Number.isFinite(observedAt) && (!Number.isFinite(lastAt) || observedAt > lastAt);
    const accountObservationText = Number.isFinite(observedAt)
      ? `${latestObservation.precision === 'approximate-minute' ? '约' : ''}${fmtDateTime(observedAt)} 北京 · ${latestObservation.sourceLabel || '账号实测'} · 仅代表单个账号`
      : '';
    const today = beijingParts(currentNow);
    const todayReset = buildTodayResetView(chart, currentNow);
    const gaps = (chart?.gapDays || []).slice(-12);
    const maxGap = Math.max(1, ...gaps);

    this.setData(
      {
        metrics: buildMetrics(chart),
        signal,
        signalAge: ageMinutes === null ? '' : ageMinutes < 1 ? '刚刚' : ageMinutes < 60 ? `${ageMinutes} 分钟前` : ageMinutes < 1440 ? `${Math.floor(ageMinutes / 60)} 小时前` : `${Math.floor(ageMinutes / 1440)} 天前`,
        todayLabel: `${today.month}.${today.day} ${today.weekday}`,
        todayReset,
        elapsedLabel: hasNewerAccountObservation ? '距上次公开确认' : '距上次重置',
        accountObservationText,
        trendBars: gaps.map((value, index) => ({ key: index, height: Math.max(4, value / maxGap * 100), latest: index === gaps.length - 1, value: value.toFixed(1) })),
        medianDays: chart?.median?.toFixed(1) ?? '—',
        analysisTitle: outlook?.announcement ? outlook.announcement.pending ? '已明确预告，等待落地确认' : '按公告窗口观察下一次重置' : '没有明确预告，按历史节奏推算',
        expandedRecord: preserveUi ? this.data.expandedRecord : '',
        gauge: buildGauge(chart),
        pred: outlook,
        // 直方图有没有东西可画。`total` 为 0 时不着 canvas —— 空白画布比没有画布更像故障
        histShow: Boolean(chart && chart.hist && chart.hist.total),
        forecast,
        survivalN: chart ? chart.gapDays.length : 0,
        basisRows: basisRows(outlook, forecast),
        calendar,
        planView,
        selectedPlanDay,
        selectedPlan,
        expandedPlanEntry,
        calendarRange: calendar ? `${calendar.fromDate.slice(5).replace('-', '.')} — ${calendar.toDate.slice(5).replace('-', '.')}` : '',
        selectedDate,
        selectedDay: calendarSelection(calendar, selectedDate),
        allRecords: records,
        recordCount: chart?.count ?? 0,
        mean: chart?.mean?.toFixed(1) ?? '',
        arrival,
        analysisOpen: preserveUi ? this.data.analysisOpen : { wait: false, backtest: false, pace: false, history: false, samples: false, arrival: false },
        trend: this.trend,
        trendCount: this.trend.length,
        trendFirst: this.trend.length ? this.trend[0].label : '',
        trendLast: this.trend.length ? this.trend[this.trend.length - 1].label : '',
        recentRecords: records.slice(0, 3),
        moreRecords: records.slice(3, 17),
        moreRecordsCount: Math.min(14, Math.max(0, records.length - 3)),
        moreRecordsOpen: preserveUi && this.data.moreRecordsOpen,
        detailsOpen: preserveUi && this.data.detailsOpen,
        programOpen: preserveUi && this.data.programOpen,
        programHeight: preserveUi ? this.data.programHeight : 0,
        signalDetailsOpen: !!(preserveUi && signal.show && this.data.signalDetailsOpen),
        genText: fmtDateTime(genTs),
        dataText: Number.isFinite(toTs(state.dataUpdatedAt)) ? fmtDateTime(toTs(state.dataUpdatedAt)).slice(5) : '未知',
        // 「观测中」后面是**当前北京时间**，由 tick 每秒推进（见 tick）。
        // 降级态是例外：那时要传达的正是「这是什么时候的快照」，显示数据时刻才有信息量。
        updText: degraded ? `快照 · ${fmtClock(genTs)}` : `观测中 · ${fmtClockSec(currentNow)}`,
        account: state.account || 'thsottiaux',
        degraded: !!degraded,
        notice: degraded ? reason || '当前展示的不是实时数据' : '',
        lastResetText: Number.isFinite(lastAt) ? `${fmtDateTime(lastAt).slice(5)} 北京` : '暂无记录',
        since: Number.isFinite(lastAt) ? `上次 ${fmtDateTime(lastAt).slice(5)} · 北京时间` : '',
        verdict: makeVerdict(chart ? chart.pct : 0),
      },
      () => {
        if (preserveUi && this.data.programOpen) this.measureProgram();
        this.tick();
        this.paint();
      }
    );
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
    if (this.data.pageVisible && this._lastLoad && Date.now() - this._lastLoad >= config.refreshIntervalMs) {
      this.load({ silent: true, force: true });
    }
    const now = Date.now();
    const patch = {};

    const today = beijingParts(now);
    const todayLabel = `${today.month}.${today.day} ${today.weekday}`;
    if (todayLabel !== this.data.todayLabel) patch.todayLabel = todayLabel;
    const todayReset = buildTodayResetView(this.chart, now);
    const currentReset = this.data.todayReset;
    if ((currentReset?.dayKey || '') !== (todayReset?.dayKey || '') ||
        (currentReset?.at ?? null) !== (todayReset?.at ?? null) ||
        (currentReset?.time || '') !== (todayReset?.time || '')) {
      patch.todayReset = todayReset;
    }

    if (this.lastAt) {
      const groups = reelGroups(elapsed(this.lastAt, now));
      // 只在数字真的变了才 setData：秒位每秒都变，但天/时/分不动时
      // 把它们一起重发会让 4 组卷轴全部重排，白白掉帧
      const sig = groups.map((g) => g.digits.join('')).join('|');
      if (sig !== this._sig) {
        this._sig = sig;
        patch.counter = groups;
        patch.elapsedGroups = groups.filter(g => g.unit !== '秒').map(g => ({ unit: g.unit, value: g.digits.join('') }));
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
    if (view !== 'analysis' || !this.ready || !this.data.pageVisible || !this.chart) return;
    if (this._painting) {
      // 快照、onReady 和联网数据可能接连到达，不能丢掉视图更新后的最后一次绘制。
      this._paintAgain = true;
      return;
    }
    this._painting = true;
    const chart = this.chart;
    try {
      // 首屏先画近七次间隔折线；展开区仍保留原有三张历史图。
      const trend = await setupCanvas(this, '#trend');
      if (trend) {
        drawScene(
          trend.ctx,
          rhythmScene(chart, {
            width: Math.round(trend.width),
            height: Math.round(trend.height),
          }),
          trend.dpr, 'night'
        );
      }

      // 展开区原有三张图共用同一个 drawScene，图元类型只有 line / circle / poly / text。
      const hist = await setupCanvas(this, '#hist');
      if (hist) {
        drawScene(
          hist.ctx,
          histogramScene(chart, {
            layout: 'compact',
            width: Math.round(hist.width),
            height: Math.round(hist.height),
          }),
          hist.dpr, 'night'
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
          surv.dpr, 'night'
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
          strip.dpr, 'night'
        );
      }
    } catch (e) {
      // canvas 2d 不可用时页面其余部分照常可用，只是没有图
      console.warn('图表绘制失败：', e && e.message);
    } finally {
      this._painting = false;
      if (this._paintAgain) {
        this._paintAgain = false;
        return this.paint();
      }
    }
  },

  /* ------------------------ F9 预告 / 落地一次性提醒 ------------------------ */

  reminderData(kind) {
    const available = subscribeAvailable(kind);
    const pending = hasPendingSync(kind);
    return {
      show: !this.data.singlePage,
      hint: SCOPE_HINT,
      selected: this.data[`${kind}Remind`]?.selected ?? true,
      label: pending ? '重试同步' : available ? ACTION_LABELS[kind] : '检查中…',
      state: pending ? 'retry' : available ? 'idle' : 'checking',
      feedback: '',
      tone: '',
    };
  },

  initRemind() {
    this.setData({
      reminderBatch: supportsBatchSubscription(),
      announcementRemind: this.reminderData('announcement'),
      landedRemind: this.reminderData('landed'),
    }, () => this.refreshReminderAction());
  },

  async refreshReminders(kinds = ['announcement', 'landed']) {
    // 真机生命周期会先经过 onLoad；夹具与局部调用也可能直接触发 onShow。
    this._remindingKinds ||= new Set();
    const targets = kinds.filter((kind) => !this.data.singlePage && !this._remindingKinds.has(kind));
    if (!targets.length) return;
    const revisions = new Map();
    for (const kind of targets) {
      const revision = ((this._remindRevisions ||= {})[kind] || 0) + 1;
      this._remindRevisions[kind] = revision;
      revisions.set(kind, revision);
    }
    const current = (kind) => revisions.get(kind) === this._remindRevisions?.[kind] && !this._remindingKinds.has(kind);
    try {
      await loadSubscriptionConfig();
      if (!this.data.singlePage) {
        this.setData({ reminderBatch: supportsBatchSubscription() });
      }
      for (const kind of targets) {
        if (!current(kind)) continue;
        if (!supportsNotificationKind(kind)) {
          const upgrade = subscribeAvailable('landed') && kind === 'announcement';
          this.setReminder(kind, {
            state: 'unavailable',
            label: upgrade ? '待服务升级' : '暂未开放',
            feedback: upgrade ? '服务端尚未支持预告通知。' : '',
            tone: upgrade ? 'warn' : '',
          });
        } else {
          this.setReminder(kind, { state: 'checking', label: '确认中…', feedback: '', tone: '' });
        }
      }
      await Promise.all(targets.filter((kind) => supportsNotificationKind(kind)).map(async (kind) => {
        try {
          const active = await subscriptionStatus(kind);
          if (!current(kind)) return;
          const pending = hasPendingSync(kind);
          this.setReminder(kind, {
            state: active ? 'on' : pending ? 'retry' : 'idle',
            label: active ? DONE_LABELS[kind] : pending ? '重试同步' : ACTION_LABELS[kind],
            feedback: pending ? '授权已获得，点击按钮完成同步。' : '',
            tone: pending ? 'warn' : '',
          });
        } catch {
          if (current(kind)) this.setReminder(kind, { state: 'unknown', label: '重试', feedback: '通知暂不可用，请稍后重试。', tone: 'warn' });
        }
      }));
    } catch {
      for (const kind of targets) {
        if (current(kind)) this.setReminder(kind, { state: 'unknown', label: '重试', feedback: '通知暂不可用，请稍后重试。', tone: 'warn' });
      }
    }
  },

  refreshRemind(kind = 'landed') {
    return this.refreshReminders([kind]);
  },

  setReminder(kind, patch) {
    const key = kind === 'announcement' ? 'announcementRemind' : 'landedRemind';
    this.setData({ [key]: Object.assign({}, this.data[key], patch) }, () => this.refreshReminderAction());
  },

  refreshReminderAction() {
    const kinds = ['announcement', 'landed'];
    const reminders = kinds.map((kind) => ({ kind, value: this.data[`${kind}Remind`] }));
    const selected = reminders.filter(({ kind, value }) => value?.show && value.selected && supportsNotificationKind(kind));
    const busy = selected.some(({ kind }) => this._remindingKinds?.has(kind));
    const checking = selected.some(({ value }) => value.state === 'checking');
    const unknown = selected.some(({ value }) => value.state === 'unknown');
    const targets = selected.filter(({ value }) => ['idle', 'retry'].includes(value.state));
    const hasRetry = targets.some(({ value }) => value.state === 'retry');
    const label = busy
      ? (hasRetry ? '同步中…' : '授权中…')
      : checking
        ? '检查中…'
        : unknown
          ? '重试检查'
          : targets.length > 1
            ? '开启重置提醒'
            : hasRetry
              ? '完成提醒设置'
              : targets.length === 1
                ? '开启所选提醒'
                : selected.length
                  ? '已开启所选提醒'
                  : '请选择提醒类型';
    this.setData({ reminderAction: {
      label,
      disabled: !this.data.reminderBatch || busy || checking || (!unknown && targets.length === 0),
      loading: busy || checking,
    } });
  },

  onSelectReminder(event) {
    if (this.data.singlePage || !this.data.reminderBatch) return;
    const kind = event?.currentTarget?.dataset?.kind;
    if (!['announcement', 'landed'].includes(kind) || !supportsNotificationKind(kind)) return;
    const key = `${kind}Remind`;
    const reminder = this.data[key];
    if (!reminder?.show || ['on', 'checking', 'busy', 'unavailable'].includes(reminder.state)) return;
    this.setReminder(kind, { selected: !reminder.selected });
  },

  onEnableReminders() {
    if (this.data.singlePage || !this.data.reminderBatch || this._remindingKinds?.size) return;
    const selected = ['announcement', 'landed'].filter((kind) => {
      const reminder = this.data[`${kind}Remind`];
      return reminder?.show && reminder.selected && supportsNotificationKind(kind);
    });
    const unknown = selected.filter((kind) => this.data[`${kind}Remind`].state === 'unknown');
    // 未知状态先重新查配置和服务端状态，不把重试检查变成一次新授权。
    if (unknown.length) return this.refreshReminders(unknown);
    const targets = selected.filter((kind) => ['idle', 'retry'].includes(this.data[`${kind}Remind`].state));
    if (!targets.length) return;
    this._remindingKinds ||= new Set();
    this._remindRevisions ||= {};
    const fresh = targets.filter((kind) => !hasPendingSync(kind));
    for (const kind of targets) {
      this._remindingKinds.add(kind);
      this._remindRevisions[kind] = (this._remindRevisions[kind] || 0) + 1;
      this.setReminder(kind, { label: hasPendingSync(kind) ? '同步中…' : '授权中…', state: 'busy', feedback: '', tone: '' });
    }
    // subscribeKinds 会先同步调用微信弹窗，再处理各类独立的后端登记。
    return subscribeKinds(targets)
      .then((results) => {
        for (const kind of targets) {
          const result = results[kind] || { ok: false, status: 'unknown', reason: '通知状态暂不可用，请重试。' };
          if (!result.ok) {
            const unavailable = result.status === 'unavailable' || result.status === 'duplicate-template';
            this.setReminder(kind, {
              label: unavailable ? '暂不可用' : ACTION_LABELS[kind],
              state: unavailable ? 'unavailable' : 'idle',
              feedback: result.reason,
              tone: 'warn',
            });
            continue;
          }
          this.setReminder(kind, {
            label: result.synced ? DONE_LABELS[kind] : '重试同步',
            state: result.synced ? 'on' : 'retry',
            tone: result.synced ? 'ok' : 'warn',
            feedback: result.synced
              ? (kind === 'announcement'
                ? '已开启；发现明确预告时提醒一次，说明尚未确认落地。'
                : '已开启；确认落地后提醒一次。')
              : '授权已记录，服务器同步失败。点击重试同步，无需再次授权。',
          });
        }
      })
      .catch((error) => {
        const reason = error?.message || '未能申请提醒，请稍后重试。';
        for (const kind of targets.filter((entry) => fresh.includes(entry))) {
          this.setReminder(kind, { label: ACTION_LABELS[kind], state: 'idle', feedback: reason, tone: 'warn' });
        }
        for (const kind of targets.filter((entry) => !fresh.includes(entry))) {
          this.setReminder(kind, { label: '重试同步', state: 'retry', feedback: reason, tone: 'warn' });
        }
      })
      .finally(() => {
        for (const kind of targets) this._remindingKinds.delete(kind);
        this.refreshReminderAction();
      });
  },

  setRemind(patch) {
    this.setReminder('landed', patch);
  },

  onToggleReminder(event) {
    if (this.data.singlePage) return;
    const kind = event?.currentTarget?.dataset?.kind || 'landed';
    const key = kind === 'announcement' ? 'announcementRemind' : 'landedRemind';
    const reminder = this.data[key];
    if (!reminder.show || this._remindingKinds.has(kind) || ['on', 'checking', 'unavailable'].includes(reminder.state)) return;
    if (reminder.state === 'unknown') return this.refreshRemind(kind);
    const retry = hasPendingSync(kind);
    this._remindingKinds.add(kind);
    this._remindRevisions ||= {};
    this._remindRevisions[kind] = (this._remindRevisions[kind] || 0) + 1;
    this.setReminder(kind, { label: retry ? '同步中…' : '授权中…', state: 'busy', feedback: '', tone: '' });
    // 微信授权必须直接来自这次点击，不在它前面等待登录或配置请求。
    return (retry ? syncSubscription(kind) : subscribeOnce(kind))
      .then((r) => {
        if (!r.ok) {
          const unsupported = r.status === 'template-changed' && !subscribeAvailable(kind);
          this.setReminder(kind, { label: unsupported ? '重试' : ACTION_LABELS[kind], state: unsupported ? 'unknown' : 'idle', feedback: r.reason, tone: 'warn' });
          return;
        }
        this.setReminder(kind, {
          label: r.synced ? DONE_LABELS[kind] : '重试同步',
          state: r.synced ? 'on' : 'retry',
          tone: r.synced ? 'ok' : 'warn',
          feedback: r.synced
            ? (kind === 'announcement'
              ? '已开启；检测到明确预告时提醒一次，通知会说明尚未确认落地。'
              : '已开启；公开完成公告确认后提醒一次。')
            : '授权已获得，服务器同步失败。点击重试同步，无需再次授权。',
        });
      })
      .catch(() => this.setReminder(kind, { label: ACTION_LABELS[kind], state: 'idle', feedback: '未能开启，请检查微信通知设置后重试。', tone: 'warn' }))
      .finally(() => { this._remindingKinds.delete(kind); });
  },

  onToggleRemind() {
    return this.onToggleReminder({ currentTarget: { dataset: { kind: 'landed' } } });
  },

  /* ------------------------------ 交互 ------------------------------ */

  onToggleProgram() {
    const programOpen = !this.data.programOpen;
    this._programMeasure++;
    this.setData({ programOpen, ...(programOpen ? {} : { programHeight: 0 }) }, () => {
      if (!programOpen) return;
      this.measureProgram();
    });
  },

  measureProgram() {
    const measure = ++this._programMeasure;
    // 静默刷新也会改变内容高度；与用户展开共用测量及迟到回写守卫。
    wx.createSelectorQuery().in(this).select('.prog-body').boundingClientRect().exec((res) => {
      if (!this.data.programOpen || measure !== this._programMeasure) return;
      const height = res?.[0]?.height;
      if (Number.isFinite(height) && height > 0) this.setData({ programHeight: Math.ceil(height) });
    });
  },

  onToggleSignalDetails() {
    if (!this.data.signal || !this.data.signal.show) return;
    this.setData({ signalDetailsOpen: !this.data.signalDetailsOpen });
  },

  onStopTap() {},

  // 只拦截遮罩手势；正文不挂此监听，交给独立 scroll-view 滚动。
  onStopTouchMove() {},

  onToggleMoreRecords() {
    this.setData({ moreRecordsOpen: !this.data.moreRecordsOpen });
  },

  onSelectCalendarDay(e) {
    const date = e?.currentTarget?.dataset?.date;
    if (!this.data.calendar?.cells.some((cell) => cell.date === date)) return;
    this.setData({ selectedDate: date, selectedDay: calendarSelection(this.data.calendar, date) });
  },

  onSelectPlanDay(e) {
    const day = Number(e?.currentTarget?.dataset?.day);
    const selectedPlan = planSelection(this.data.planView, day);
    if (!selectedPlan) return;
    this.setData({ selectedPlanDay: day, selectedPlan, expandedPlanEntry: '' });
  },

  onTogglePlanEntry(e) {
    const key = String(e?.currentTarget?.dataset?.key || '');
    if (!key || !this.data.selectedPlan?.entries.some((entry) => entry.key === key && entry.hasText)) return;
    this.setData({ expandedPlanEntry: this.data.expandedPlanEntry === key ? '' : key });
  },

  onToggleRecord(e) {
    const key = e?.currentTarget?.dataset?.key;
    if (!this.data.allRecords.some(record => record.key === key)) return;
    this.setData({ expandedRecord: this.data.expandedRecord === key ? '' : key });
  },

  onToggleAnalysis(e) {
    const key = e?.currentTarget?.dataset?.section;
    if (!Object.prototype.hasOwnProperty.call(this.data.analysisOpen, key)) return;
    this.setData({ [`analysisOpen.${key}`]: !this.data.analysisOpen[key] }, () => this.paint());
  },

  onOpenAnalysis() {
    if (!this.data.singlePage) wx.switchTab({ url: '/pages/analysis/index' });
  },

  onToggleDetails() {
    const detailsOpen = !this.data.detailsOpen;
    this.setData({ detailsOpen }, () => {
      if (detailsOpen) this.paint();
    });
  },

  onHeroTouch(e) {
    if (!this.data.pageVisible) return;
    const touch = (e && e.touches && e.touches[0]) || (e && e.changedTouches && e.changedTouches[0]);
    if (!touch) return;
    const clientX = Number.isFinite(touch.clientX) ? touch.clientX : touch.pageX;
    const clientY = Number.isFinite(touch.clientY) ? touch.clientY : touch.pageY;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;

    wx.createSelectorQuery()
      .in(this)
      .select('#forecast')
      .boundingClientRect()
      .exec((res) => {
        const rect = res && res[0];
        if (!rect || !this.data.pageVisible) return;
        this.setData({
          ripple: {
            show: true,
            x: clientX - rect.left,
            y: clientY - rect.top,
          },
        });
        this.clearRippleTimer();
        this._rippleTimer = setTimeout(() => {
          this._rippleTimer = null;
          this.setData({ ripple: { show: false, x: 0, y: 0 } });
        }, 900);
      });
  },

  clearRippleTimer() {
    if (this._rippleTimer) {
      clearTimeout(this._rippleTimer);
      this._rippleTimer = null;
    }
  },

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
    if (this.data.singlePage) return;
    const fromItem = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.url;
    const url = fromItem || (this.data.signal && this.data.signal.url);
    copyText(url);
  },

  onCopyCalendarSource(e) {
    if (this.data.singlePage) return;
    const url = e?.currentTarget?.dataset?.url;
    if (url) copyText(url);
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
      path: view === 'records' ? '/pages/history/index' : view === 'analysis' ? '/pages/analysis/index' : '/pages/index/index',
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
    if (view === 'records') return historyShareTitle({ count: this.data.recordCount, mean: this.data.mean });
    if (view === 'analysis') return 'TIBO 重置预测 · 历史与模型依据';
    return indexShareTitle({ signal: this.data.signal, lastAt: this.lastAt });
  },
  };
}
