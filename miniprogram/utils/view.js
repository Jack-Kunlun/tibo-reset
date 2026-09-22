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
 * 预告窗口的「大字公告」。
 *
 * 星期是最大的字 —— 人从「Tibo 说下周二重置」里最先抓住的就是「周二」，
 * 日期与时段退到副行。把一整串「2026.09.23（周三）08:00 → 09.24 14:59」
 * 原样铺在最显眼的位置，等于把数据当排版用。
 */
function headlineOf(top, w) {
  const uf = w && w.userFrom;
  if (!uf) return null;

  const md = `${Number(uf.m)}.${Number(uf.d)}`;
  const hhmm = `${String(uf.hh).padStart(2, '0')}:${String(uf.mm).padStart(2, '0')}`;
  const p = top.precision || '';
  const pText = PRECISION_TEXT[p] || '';

  if (p === 'week' || p === 'week-part') {
    return { big: '本周', sub: `${md} 起 · ${pText}` };
  }

  const tail = p === 'evening' ? '当晚' : p === 'instant' ? `${hhmm} 前后` : '全天';
  return { big: uf.weekdayCN || md, sub: `${md} · ${tail}` };
}

/**
 * 信号横幅视图模型。
 *
 * 规范：**只有拿到了「时间窗口」才进醒目态**。
 * 只有情绪没有时间的推文（「快了」「soon」）不足以支撑一个横幅 ——
 * 那会变成制造焦虑的假信号。
 *
 * 这一区**只讲未来**：预告（可行动）> 线索（弱依据兜底）。
 *
 * ⚠ 已经发生过的重置**不在这里列举**。它是往回看的事实，而这块回答的是
 *   「下一次什么时候」。同一段事实已经有载体 —— 首页顶部的「距上次重置 N 天」
 *   与重置历史页 —— 再把它顶上横幅，只是复述，还挤掉真正可行动的信息。
 *   检测能力保留在数据层（`signals.occurred` 照常识别与计数），只是不参与呈现。
 *
 * 旧实现是 `explicit ? signals : hint ? hints : []` 三选一 —— 只要没有预告就退到
 * 线索档，于是横幅上显示的是「11pm on a Tuesday」这类与额度无关的推文，
 * 而真正的重置根本不出现。现在预告优先，线索只在没有预告时兜底。
 */
export function buildSignal(sig) {
  if (!sig) return { show: false, checked: 0, lookback: 60, windowFrom: '' };

  const explicit = (sig.signals || []).find((s) => s.window) || null;
  if (explicit) return signalView(explicit, 'explicit');

  const hint = (sig.hints || []).find((s) => s.window) || null;
  if (hint) return signalView(hint, 'hint');

  return {
    show: false,
    checked: sig.checkedTweets,
    lookback: sig.lookbackDays,
    windowFrom: sig.windowFrom || '',
    hintCount: (sig.hints || []).length,
  };
}

function signalView(top, level) {
  const w = top.window || null;
  const meta =
    level === 'explicit'
      ? { badge: '明确信号', title: 'Tibo 已预告下一次额度重置' }
      : { badge: '线索', title: '有一条与额度相关的时间线索' };

  return {
    show: true,
    level,
    badge: meta.badge,
    title: meta.title,
    precision: PRECISION_TEXT[top.precision] || top.precision || '',
    // 大字公告：星期 + 日期/时段
    headline: headlineOf(top, w),
    window: w
      ? {
          sourceZone: w.sourceZone,
          userZone: w.userZone,
          srcOffset: (w.zones && w.zones.b && w.zones.b.offset) || '',
          usrOffset: (w.zones && w.zones.a && w.zones.a.offset) || '',
          diffText: (w.zones && w.zones.diffText) || '',
          crosses: !!w.crossesUserDay,
          // 数字时间戳直通，供页面做每秒倒计时（不做字符串反解析）
          fromTs: w.fromTs ?? null,
          toTs: w.toTs ?? null,
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

/* ------------------------------ 等待进度尺 ------------------------------ */

/**
 * 把「当前等待在历史中处于什么位置」画成一条进度尺。
 *
 * 这个信息 verdict 已经用文字说过一遍了。但文字是抽象的 ——
 * 一条快填满的尺子不用读，扫一眼就知道「已经等很久了」。
 * 颜色跟着档位走：常规竹青、偏长岚青、明显偏久朱砂。
 */
export function buildGauge(chart) {
  if (!chart) return null;
  const p = Math.max(0, Math.min(1, chart.pct));
  return {
    fill: (p * 100).toFixed(1),
    cls: p >= 0.7 ? 'hot' : p >= 0.5 ? 'warm' : 'cool',
    text: `已超过历史上 ${Math.round(p * 100)}% 的重置间隔`,
  };
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
