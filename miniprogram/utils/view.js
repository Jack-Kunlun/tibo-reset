/**
 * 数据 → 视图模型（纯函数，无副作用、不碰 wx.*）。
 *
 * 单独成文件的原因：这些是页面里唯一需要动脑的部分（信号怎么判醒目、
 * 预测数字怎么排版），而它们完全可以脱离小程序宿主运行。
 * 抽出来之后能在 Node 里直接喂数据做回归 —— 包括「真的来了明确信号时
 * 横幅长什么样」这种平时根本触发不到的路径。
 */

import { fmtDate, pct1, trim1 } from './format.js';

const PRECISION_TEXT = {
  day: '全天',
  evening: '当晚',
  week: '整周',
  'week-part': '一周内的某几天',
  instant: '具体时刻前后',
};

/* ------------------------------ 信号 ------------------------------ */

/**
 * 信号横幅视图模型。
 *
 * 规范：**只有拿到了「时间窗口」才进醒目态**。
 * 只有情绪没有时间的推文（「快了」「soon」）不足以支撑一个横幅 ——
 * 那会变成制造焦虑的假信号。
 */
export function buildSignal(sig) {
  if (!sig) return { show: false, checked: 0, lookback: 60 };

  const items = sig.level === 'explicit' ? sig.signals : sig.level === 'hint' ? sig.hints : [];
  const top = items.find((s) => s.window) || items[0];

  if (!top || (sig.level !== 'explicit' && !top.window)) {
    return { show: false, checked: sig.checkedTweets, lookback: sig.lookbackDays };
  }

  const w = top.window;
  const meta =
    sig.level === 'explicit'
      ? { badge: '明确信号', title: 'Tibo 已预告下一次额度重置' }
      : { badge: '线索', title: '有一条与额度相关的时间线索' };

  return {
    show: true,
    level: sig.level,
    badge: meta.badge,
    title: meta.title,
    precision: PRECISION_TEXT[top.precision] || top.precision || '',
    window: w
      ? {
          sourceZone: w.sourceZone,
          userZone: w.userZone,
          srcOffset: (w.zones && w.zones.b && w.zones.b.offset) || '',
          usrOffset: (w.zones && w.zones.a && w.zones.a.offset) || '',
          diffText: (w.zones && w.zones.diffText) || '',
          crosses: !!w.crossesUserDay,
        }
      : null,
    text: top.text || '',
    timeNote: top.timeNote || '',
    reason: (top.reasons || []).join('、'),
    // 双时区文本在采集侧就算好了：小程序端算它要依赖 Intl，部分安卓机型不可用
    createdText: top.createdZones
      ? `${top.createdZones.a.text} 北京 · ${top.createdZones.b.text} 当地`
      : '',
    url: top.url || '',
  };
}

/* ------------------------------ 指标 ------------------------------ */

export function buildMetrics(chart) {
  if (!chart) return [];
  return [
    { k: '平均间隔', v: chart.mean.toFixed(1), u: '天', note: '被极端值拉高' },
    { k: '中位间隔', v: chart.median.toFixed(1), u: '天', note: '一半情况比这更快', hi: true },
    { k: '最长等待', v: chart.longest.toFixed(1), u: '天', note: '极端长尾' },
    { k: '记录总数', v: String(chart.count), note: `${fmtDate(new Date(chart.firstAt).getTime())} 起` },
    { k: '普通重置', v: String(chart.count - chart.creditCount), note: '额度直给' },
    { k: '发券型', v: String(chart.creditCount), note: '改成给券' },
  ];
}

/* ------------------------------ 预测 ------------------------------ */

/**
 * 预测区块视图模型。
 *
 * 只输出数字与单位，不写「本模型不预测什么」这类关于模型自身的说明；
 * 但**数据类披露必须留**：覆盖率、区分度、样本量 —— 那是数字，不是散文。
 */
export function buildForecast(pred) {
  if (!pred || !pred.prediction) return null;

  const p = pred.prediction;
  const cal = pred.calibration;
  const hours = Math.round(p.q50 * 24);
  const sk = pred.skill.score;
  const nearZero = Math.abs(sk) < 0.05;
  const skillShort = nearZero
    ? '≈ 无区分力'
    : sk > 0
      ? `优于盲猜 ${(sk * 100).toFixed(1)}%`
      : `略差于盲猜 ${(sk * 100).toFixed(1)}%`;

  const cov50Ok = Math.abs(cal.cov50 - 0.5) < 0.1;
  const cov80Ok = Math.abs(cal.cov80 - 0.8) < 0.1;

  return {
    q50: trim1(p.q50),
    hoursText: hours >= 1 ? `约 ${hours} 小时` : '',
    rangeText: `${trim1(p.q25)} – ${trim1(p.q90)}`,
    bars: p.horizons.map((h) => ({
      label: h.label,
      w: Math.max(1, Math.min(100, h.p * 100)).toFixed(1),
      pv: pct1(h.p),
    })),
    cal: {
      n: cal.n,
      rows: [
        {
          k: '50% 分位覆盖率',
          v: pct1(cal.cov50),
          ok: cov50Ok,
          j: cov50Ok ? '校准良好' : '偏离目标',
        },
        {
          k: '80% 分位覆盖率',
          v: pct1(cal.cov80),
          ok: cov80Ok,
          j: cov80Ok ? '校准良好' : '区间偏宽',
        },
        {
          k: '7 天区分度',
          v: skillShort,
          ok: false,
          j: `Brier ${pred.skill.brier.toFixed(3)} / 盲猜 ${pred.skill.baseline.toFixed(3)}`,
        },
      ],
    },
    phases: pred.phases.map((ph, i) => ({
      i: i + 1,
      from: fmtDate(new Date(ph.from).getTime()),
      to: fmtDate(new Date(ph.to).getTime()),
      mean: ph.mean.toFixed(2),
      n: ph.n,
      max: ph.max.toFixed(0),
    })),
    phaseSummary: pred.phases.length
      ? `平均间隔从 ${pred.phases[0].mean.toFixed(1)} 天降到 ${pred.phases[pred.phases.length - 1].mean.toFixed(1)} 天。`
      : '',
  };
}
