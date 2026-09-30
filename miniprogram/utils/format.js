/**
 * 时间与数字格式化。
 *
 * ⚠ 刻意**不用 Intl**：小程序在部分安卓机型上 Intl 不可用或不完整，
 *   而这里要格式化的是两个固定时区，可以完全确定地手算。
 *
 * ⚠ 也刻意**不用 new Date().getHours()**：那读的是设备本地时区，
 *   用户在境外或改了系统时区，页面就会显示错的时间。
 */

const CJK_OFFSET_MS = 8 * 3600 * 1000; // 中国自 1991 年起无夏令时，+08:00 恒定

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export const pad2 = (n) => String(n).padStart(2, '0');

/** 取某个时刻的北京时间各字段 */
export function beijingParts(ts) {
  const d = new Date(ts + CJK_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: pad2(d.getUTCMonth() + 1),
    day: pad2(d.getUTCDate()),
    hour: pad2(d.getUTCHours()),
    minute: pad2(d.getUTCMinutes()),
    second: pad2(d.getUTCSeconds()),
    weekday: WEEKDAYS[d.getUTCDay()],
  };
}

/**
 * 把「一个时刻的任意表示」收敛成时间戳；取不到就给 NaN。
 *
 * 存在的理由：数据层给的时刻是 **ISO 串**（`2026-07-25T02:15:29.011Z`，
 * 原始值、可复核），端上要显示就得先解析。少了解析这一环、把串直接渲进
 * 模板，页面上就会出现机器格式的时间 —— 实测在「静默态」那行发生过。
 *
 * 集中在这里而不是各处手写 `new Date(x).getTime()`：解析规则只该有一份。
 */
export function toTs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string' || !v) return NaN;
  const ts = Date.parse(v);
  return Number.isFinite(ts) ? ts : NaN;
}

/** 2026.09.12 */
export function fmtDate(ts) {
  const p = beijingParts(ts);
  return `${p.year}.${p.month}.${p.day}`;
}

/** 时刻（ISO 串或时间戳）→ 北京日期 `2026.09.12`；取不到给空串 */
export function fmtDay(v) {
  const ts = toTs(v);
  return Number.isFinite(ts) ? fmtDate(ts) : '';
}

/** 2026.09.12 16:09 */
export function fmtDateTime(ts) {
  const p = beijingParts(ts);
  return `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}`;
}

/** 16:09 */
export function fmtClock(ts) {
  const p = beijingParts(ts);
  return `${p.hour}:${p.minute}`;
}

/**
 * 16:09:37 —— 页首「观测中」后面那个**当前北京时间**，精确到秒。
 * 与 fmtClock 分开：别处要的是「某件事发生在几点几分」，秒只会添乱。
 */
export function fmtClockSec(ts) {
  const p = beijingParts(ts);
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** 2026.09.12（周六）16:09 */
export function fmtDateTimeWeek(ts) {
  const p = beijingParts(ts);
  return `${p.year}.${p.month}.${p.day}（${p.weekday}）${p.hour}:${p.minute}`;
}

/**
 * 距上次重置的时间差，拆成天/时/分/秒。
 * 用绝对时间戳相减，与设备时区无关。
 */
export function elapsed(fromTs, now = Date.now()) {
  const ms = Math.max(0, now - fromTs);
  const DAY = 86400000;
  return {
    ms,
    d: Math.floor(ms / DAY),
    h: Math.floor((ms % DAY) / 3600000),
    m: Math.floor((ms % 3600000) / 60000),
    s: Math.floor((ms % 60000) / 1000),
  };
}

/**
 * 把一段时长（单位：天，可含小数）拆成「主数字 + 单位串」。
 *
 * 与网页端 `src/lib/render.mjs` 的 `spanOf` **同口径**：保留最高的非零单位当主数字，
 * 再给下一级补精度（≥1 天 → `6` + `天 17 小时`；<1 天 → `20` + `小时 41 分`）。
 * 两份实现是刻意分开的 —— 小程序与网页是两套运行时，没有共享构建；
 * 但**口径必须一致**，否则同一份数据两边显示会不一样。
 *
 * 为什么不一律换成小时/秒：6.7 天 = 160.8 小时，读者得先心算才知道量级。
 * ⚠ 入参要传**原始浮点天数**，不要先 toFixed 再传（会凭空造出舍入误差）。
 */
export function spanOf(days) {
  if (!Number.isFinite(days) || days < 0) return { big: '—', unit: '', text: '—' };
  const total = Math.round(days * 86400);
  const D = Math.floor(total / 86400);
  const H = Math.floor((total % 86400) / 3600);
  const M = Math.floor((total % 3600) / 60);
  const S = total % 60;
  let big;
  let unit;
  if (D >= 1) {
    big = String(D);
    unit = H > 0 ? `天 ${H} 小时` : '天';
  } else if (H >= 1) {
    big = String(H);
    unit = M > 0 ? `小时 ${M} 分` : '小时';
  } else if (M >= 1) {
    big = String(M);
    unit = S > 0 ? `分 ${S} 秒` : '分';
  } else {
    big = String(S);
    unit = '秒';
  }
  return { big, unit, text: `${big} ${unit}` };
}

/** 一句话里用的完整串。要拆成大字 + 小字时直接用 `spanOf`。 */
export const fmtSpan = (days) => spanOf(days).text;

/**
 * 把时间差转成「数字卷轴」需要的结构。
 *
 * 每一组是一串独立的数字位，这样页面上可以逐位做滚动动画。
 * 天数不补零（会随时间变长），时/分/秒固定两位（避免宽度跳动）。
 */
export function reelGroups(el) {
  return [
    { unit: '天', digits: String(el.d).split('') },
    { unit: '时', digits: pad2(el.h).split('') },
    { unit: '分', digits: pad2(el.m).split('') },
    { unit: '秒', digits: pad2(el.s).split('') },
  ];
}

/**
 * 倒计时：距某个未来时刻还剩多久。
 *
 * 没有复用 elapsed —— 那是「已过去多久」，会把负值 clamp 成 0，
 * 而倒计时必须区分「还没到」和「窗口已经开了」这两种状态。
 */
export function countdown(toTs, now = Date.now()) {
  const ms = toTs - now;
  const a = Math.abs(ms);
  const DAY = 86400000;
  return {
    ms,
    over: ms <= 0,
    d: Math.floor(a / DAY),
    h: Math.floor((a % DAY) / 3600000),
    m: Math.floor((a % 3600000) / 60000),
    s: Math.floor((a % 60000) / 1000),
  };
}

/** 倒计时数字组：与 reelGroups 同构，便于同一套样式渲染 */
export function countdownGroups(cd) {
  return [
    { v: String(cd.d), unit: '天' },
    { v: pad2(cd.h), unit: '时' },
    { v: pad2(cd.m), unit: '分' },
    { v: pad2(cd.s), unit: '秒' },
  ];
}

/** 判定文案：当前等待在历史中处于什么位置 */
export function verdict(pct) {
  const p = Math.round(pct * 100);
  const tail = `历史上 ${100 - p}% 的间隔比现在更长`;
  if (pct >= 0.88) return { cls: 'rare', text: '罕见的长等待', tail };
  if (pct >= 0.7) return { cls: 'long', text: '明显偏久', tail };
  if (pct >= 0.5) return { cls: 'watch', text: '已进入偏长区间', tail };
  return { cls: 'calm', text: '仍在常规节奏内', tail };
}

export const pct1 = (x) => (x * 100).toFixed(1) + '%';

export const trim1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
