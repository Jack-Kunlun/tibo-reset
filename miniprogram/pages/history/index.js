/**
 * 历史记录页。
 *
 * 数据与首页同源（chart.records 已按时间升序），这里倒序展示。
 * 「间隔天数」是在同一次数据里顺推出的，不额外请求接口。
 */

import { loadState } from '../../utils/api.js';
import { fmtDate, fmtClock, fmtDateTime, beijingParts, trim1 } from '../../utils/format.js';

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
    this.load();
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
          updText: degraded ? '快照' : `观测中 · ${fmtDateTime(genTs).slice(11)}`,
          degraded: !!degraded,
          notice: degraded ? reason || '当前展示的不是实时数据' : '',
        });
      })
      .catch(() => wx.stopPullDownRefresh());
  },

  onCopy(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '链接已复制', icon: 'none' }),
    });
  },
});
