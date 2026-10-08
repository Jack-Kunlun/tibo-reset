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
/**
 * 间隔直方图的分桶边界。**与 `predict.mjs` 的 `DEFAULT_BREAKS` 是同一组**
 * （[0,1,2,3,5,8,14,30,∞)）—— 刻意不另起一套：
 * 图上的柱子回答「历史上重置通常在第几天」，而风险模型正是在同一组桶上估计风险率。
 * 两边各写一套的话，读者会看到「图上第 3–5 天最多」而模型算的是另一个区间。
 *
 * `null` 表示「无上界」：这份数据要进快照（JSON），`Infinity` 会被序列化成 `null`，
 * 与其让两侧看到不同的形状，不如一开始就用 `null`。
 */
export const HIST_BREAKS = [0, 1, 2, 3, 5, 8, 14, 30, null];

/** 分桶的轴标签。等宽排布（**不是**按天数等比），所以标签必须自带区间含义。 */
export const HIST_LABELS = ['0–1', '1–2', '2–3', '3–5', '5–8', '8–14', '14–30', '30+'];

/**
 * 「历史上重置通常在第几天发生」的分桶计数。
 *
 * 这是**已完成的间隔**的分布（不含进行中的那一截）—— 与 `gapDays` 同源，
 * 所以图上的柱子加起来必然等于 `gapDays.length`，不会与「n = N 次历史间隔」打架。
 *
 * ⚠ 区间取**左闭右开** `[from, to)`，而不是 `(from, to]`。
 * 后者在两端各漏掉一个点，而且都是能踩到的：
 *   · 左端：间隔恰为 0（两条记录同一时刻）时，`d > 0` 对任何桶都不成立 ——
 *     这个点被静默丢掉，柱子合计就少一次，图与正文的「共 N 次」当场对不上。
 *   · 右端：最后一档上界是无穷，`(30, ∞]` 永远兜得住，于是「超出最后一档」这个
 *     分支根本不可达（那段曾经写在注释里，是错的）。
 * 左闭右开则 `[0, ∞)` 被恰好划分，无重叠、无遗漏。
 */
function buildHist(gapDays) {
  const buckets = HIST_BREAKS.slice(0, -1).map((from, i) => {
    const to = HIST_BREAKS[i + 1];
    const n = gapDays.filter((d) => d >= from && (to === null || d < to)).length;
    return { from, to, label: HIST_LABELS[i], n };
  });
  const max = buckets.reduce((m, b) => Math.max(m, b.n), 0);
  return { breaks: HIST_BREAKS, buckets, max, total: gapDays.length };
}

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

  // 当前这一截等待落在哪个桶（「当前已过时长位于什么区间」）。
  // 区间是左闭右开（与 buildHist 同一套边界，见那里的注释），所以
  // `sinceDays = 0`（重置刚发生）落在「0–1」档，而不是落空。
  // 由此 `current === -1` 只在一种情况下出现：桶列表为空。图上就不该有点亮的柱子。
  const hist = buildHist(gapDays);
  const bucketOf = (d) => hist.buckets.findIndex((b) => d >= b.from && (b.to === null || d < b.to));
  hist.current = bucketOf(sinceDays);
  // 历史中位间隔落在哪一档。与 current 共用同一个 `bucketOf` ——
  // 「桶的边界怎么判」只应有一处实现，否则图表与正文会对同一段天数给出不同归属。
  hist.medianBucket = bucketOf(median);

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
    hist,
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
