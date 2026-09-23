/**
 * 历史记录页。
 *
 * 数据与首页同源（chart.records 已按时间升序），这里倒序展示。
 * 「间隔天数」是在同一次数据里顺推出的，不额外请求接口。
 */

import { loadState } from '../../utils/api.js';
import { copyText } from '../../utils/clipboard.js';
import { fmtDate, fmtClock, fmtClockSec, beijingParts, trim1 } from '../../utils/format.js';

const DAY = 86400000;

function buildRows(chart) {
  if (!chart || !chart.records || !chart.records.length) return [];

  const asc = chart.records; // 已是升序
  return asc
    .map((r, i) => {
      const ts = new Date(r.at).getTime();
      const p = beijingParts(ts);
      // 第一条没有「上一间隔」，间隔挂在后一条上（表示「距上次过了多久」）
      const gap = i === 0 ? null : (ts - new Date(asc[i - 1].at).getTime()) / DAY;
      return {
        at: r.at,
        ts,
        date: fmtDate(ts),
        time: fmtClock(ts),
        weekday: p.weekday,
        type: r.type === 'credit' ? 'credit' : 'reset',
        typeName: r.type === 'credit' ? '发券型' : '普通重置',
        text: r.text || '（无原文）',
        url: r.url || '',
        gapText: gap == null ? '' : `间隔 ${trim1(gap)} 天`,
      };
    })
    .reverse();
}

Page({
  data: {
    rows: [],
    count: 0,
    mean: '',
    median: '',
    updText: '',
    degraded: false,
    notice: '',
  },

  onLoad() {
    this._clock = null;
    this._upd = null;
    this.load();
  },

  // 右上角「观测中」跟真实时钟走 —— 与首页同一个 badge，含义必须一样。
  // 降级态不参与：那时它显示的是快照时刻，是个固定值。
  onShow() {
    this.startClock();
  },

  onHide() {
    this.stopClock();
  },

  onUnload() {
    this.stopClock();
  },

  startClock() {
    this.stopClock();
    this.tickClock();
    this._clock = setInterval(() => this.tickClock(), 1000);
  },

  stopClock() {
    if (this._clock) {
      clearInterval(this._clock);
      this._clock = null;
    }
  },

  tickClock() {
    if (this.data.degraded) return;
    const t = fmtClockSec(Date.now());
    if (t !== this._upd) {
      this._upd = t;
      this.setData({ updText: '观测中 · ' + t });
    }
  },

  onPullDownRefresh() {
    this.load({ force: true }).then(() => wx.stopPullDownRefresh());
  },

  load(opts = {}) {
    return loadState({ force: !!opts.force })
      .then(({ state, degraded, reason }) => {
        const chart = state.chart;
        const genTs = state.generatedAt ? new Date(state.generatedAt).getTime() : Date.now();
        this.setData({
          rows: buildRows(chart),
          count: chart ? chart.count : 0,
          mean: chart ? chart.mean.toFixed(1) : '—',
          median: chart ? chart.median.toFixed(1) : '—',
          // 「观测中」后面是**当前北京时间**（由 startClock 每秒推进），不是数据采集时刻 ——
          // 后者会被读成「现在几点」，看到几小时前的数字就以为页面停更了。
          // 降级态反过来：那时要说的正是「这是什么时候的快照」，所以给数据时刻，
          // 文案与首页对齐（此前这里是光秃秃一个「快照」，同一 badge 两页不同口径）。
          updText: degraded ? `快照 · ${fmtClock(genTs)}` : `观测中 · ${fmtClockSec(Date.now())}`,
          degraded: !!degraded,
          notice: degraded ? reason || '当前展示的不是实时数据' : '',
        });
      })
      .catch(() => wx.stopPullDownRefresh());
  },

  // 同首页：复制原推链接，失败兜底在 utils/clipboard.js
  onCopy(e) {
    copyText(e.currentTarget.dataset.url);
  },
});
