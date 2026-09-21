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

/** 2026.09.12 */
export function fmtDate(ts) {
  const p = beijingParts(ts);
  return `${p.year}.${p.month}.${p.day}`;
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
