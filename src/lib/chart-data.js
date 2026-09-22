/**
 * 从事件记录构建「统一图表数据」。
 *
 * 为什么单独一层：网页端（构建时，Node）与小程序端（运行期，快照或接口）
 * 必须喂给图表**完全相同形状**的数据，否则两张图会静默给出不同的数。
 * 所以这里只输出纯 JSON 可序列化的对象，不含函数、不含 Date 实例。
 *
 * 本文件是 ESM，可同时被 Node 与微信小程序加载（小程序需开启 es6 编译）。
 */

const DAY = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');

const iso = (t) => new Date(t).toISOString();

/**
 * @param {Array} records 事件记录，至少含 announced_at
 * @param {number} now    计算基准时刻
 * @returns {object|null}
 */
export function buildChartData(records, now = Date.now()) {
  const asc = (records ?? [])
    .filter((r) => r && r.announced_at)
    .map((r) => ({ ...r, t: new Date(r.announced_at).getTime() }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);

  if (asc.length < 2) return null;

  // 已完成的间隔。最后一条记录到 now 之间是「右删失」区间：
  // 只进入 sinceDays，不进入 gapDays —— 否则会把一个尚未结束的等待当成已完成间隔。
  const gapDays = [];
  for (let i = 1; i < asc.length; i++) gapDays.push((asc[i].t - asc[i - 1].t) / DAY);

  const sorted = [...gapDays].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  const last = asc[asc.length - 1];
  const sinceDays = (now - last.t) / DAY;
  const pct = sorted.filter((v) => v <= sinceDays).length / sorted.length;

  const thin = (r) => ({
    id: r.id ?? null,
    at: iso(r.t),
    type: r.type ?? 'reset',
    text: r.text ?? '',
    url: r.url ?? null,
    attribution: r.attribution ?? null,
  });

  return {
    now,
    count: asc.length,
    gapDays,
    sorted,
    mean,
    median,
    longest: sorted[sorted.length - 1],
    shortest: sorted[0],
    sinceDays,
    pct,
    firstAt: iso(asc[0].t),
    lastAt: iso(last.t),
    lastText: last.text ?? '',
    creditCount: asc.filter((r) => r.type === 'credit').length,
    records: asc.map(thin),
  };
}

/** 把 ISO 时间按**指定时区**格式化为 YYYY.MM.DD（不依赖运行环境默认时区） */
export function fmtDateIn(isoStr, timeZone = 'Asia/Shanghai') {
  const p = partsIn(isoStr, timeZone);
  return `${p.year}.${p.month}.${p.day}`;
}

/** 把 ISO 时间按指定时区格式化为 YYYY.MM.DD HH:mm */
export function fmtDateTimeIn(isoStr, timeZone = 'Asia/Shanghai') {
  const p = partsIn(isoStr, timeZone);
  return `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}`;
}

/** 拿指定时区的年月日时分（用 Intl，避免手算夏令时） */
export function partsIn(isoStr, timeZone) {
  const d = new Date(isoStr);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    // 秒字段是给页首「观测中 · HH:MM:SS」用的 —— 那个钟点要跟着真实时钟走。
    // 其余调用方按键取值，多这一个字段对它们无影响。
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const out = {};
  for (const part of fmt.formatToParts(d)) if (part.type !== 'literal') out[part.type] = part.value;
  // en-CA 的 hour 在 24 小时制下可能给出 "24"
  if (out.hour === '24') out.hour = '00';
  out.weekdayCN = WEEKDAY_CN[out.weekday] ?? out.weekday;
  return out;
}

const WEEKDAY_CN = { Sun: '周日', Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六' };

/** 该时刻在指定时区的 UTC 偏移（小时），例如太平洋夏令时返回 -7 */
export function offsetHours(isoStr, timeZone) {
  const d = new Date(isoStr);
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) + Number(m[3] ?? 0) / 60);
}

/**
 * 双时区说明。信号展示的核心：推文的时间语境在发推者那边，
 * 用户在中国 —— 只给北京时间会丢掉信息，只给太平洋时间又看不懂。
 */
export function dualZone(isoStr, zoneA = 'Asia/Shanghai', zoneB = 'America/Los_Angeles', labelA = '北京时间', labelB = 'Tibo 当地时间') {
  const pa = partsIn(isoStr, zoneA);
  const pb = partsIn(isoStr, zoneB);
  const oa = offsetHours(isoStr, zoneA);
  const ob = offsetHours(isoStr, zoneB);
  const diff = oa - ob;
  return {
    a: {
      label: labelA,
      zone: zoneA,
      date: `${pa.year}.${pa.month}.${pa.day}`,
      weekday: pa.weekdayCN,
      time: `${pa.hour}:${pa.minute}`,
      text: `${pa.year}.${pa.month}.${pa.day}（${pa.weekdayCN}）${pa.hour}:${pa.minute}`,
      offset: `UTC${oa >= 0 ? '+' : ''}${trimNum(oa)}`,
    },
    b: {
      label: labelB,
      zone: zoneB,
      date: `${pb.year}.${pb.month}.${pb.day}`,
      weekday: pb.weekdayCN,
      time: `${pb.hour}:${pb.minute}`,
      text: `${pb.year}.${pb.month}.${pb.day}（${pb.weekdayCN}）${pb.hour}:${pb.minute}`,
      offset: `UTC${ob >= 0 ? '+' : ''}${trimNum(ob)}`,
    },
    // 「北京时间比当地快 N 小时」——跨夏令时会变，所以按时刻动态算
    diffHours: diff,
    diffText: `北京时间比 Tibo 当地时间快 ${trimNum(diff)} 小时`,
  };
}

export const trimNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

export const pad2 = pad;
