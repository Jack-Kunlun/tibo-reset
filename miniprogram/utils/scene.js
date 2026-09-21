/** ⚠ 本文件由 scripts/build.mjs 从 src/lib/scene.js 同步生成，请勿直接修改。 */
/**
 * 图元几何 —— 与渲染目标无关的中间表示。
 *
 * 为什么要这一层：同一张图要在两个地方画出来 ——
 *   1. 网页端：构建时在 Node 里跑，序列化成内联 SVG（出厂即完整，不依赖运行时 JS）
 *   2. 小程序端：运行期在小程序里跑，画到 canvas 2d（小程序的 <image> 不认 SVG）
 *
 * 如果两边各自实现一遍坐标计算，一定会漂移，而且漂移是静默的 ——
 * 两边都能画出图，只是数不一样。所以这里只输出「画什么」，不决定「怎么画」。
 *
 * ⚠ 本文件被 scripts/build.mjs 同步到 miniprogram/utils/scene.js，不要直接改小程序侧那份。
 * ⚠ 必须是纯 JS：不能用 Node API、不能用 Date 的本地时区、不能有副作用。
 */

/* ------------------------------- 调色板 ------------------------------- */
/* 风岚水墨风：宣纸白 + 墨黑 + 雾灰 + 岚青 + 竹青 + 朱砂 */

export const PALETTE = {
  paper: '#FAF8F4',
  paper2: '#F2EFE8',
  card: '#FFFFFF',
  ink: '#1F1E1B',
  ink2: '#4A4842',
  mist: '#8C8880',
  line: '#E4DFD5',
  lan: '#3F7376',
  lanSoft: '#5B9296',
  bamboo: '#5F8455',
  cinnabar: '#B3563C',
};

/* ------------------------------- 图元构造 ------------------------------- */

const line = (x1, y1, x2, y2, o = {}) => ({ k: 'line', x1, y1, x2, y2, ...o });
const text = (x, y, s, o = {}) => ({ k: 'text', x, y, s: String(s), ...o });
const circle = (cx, cy, r, o = {}) => ({ k: 'circle', cx, cy, r, ...o });
const poly = (pts, o = {}) => ({ k: 'poly', pts, ...o });

/* ------------------------------- 文字度量 ------------------------------- */

const isWide = (ch) => ch.codePointAt(0) > 0x2e7f;

/**
 * 估算一行文字的宽度（单位与坐标一致）。
 *
 * canvas 没有「量完再决定锚点」的便利，测试也需要判断文字会不会出界，
 * 所以两边都用同一个估算法。这是近似值，不是精确排版结果 ——
 * 用途是「防止明显出界」，不是「像素级对齐」。
 */
export function estimateTextWidth(s, size, mono = false) {
  let w = 0;
  for (const ch of String(s)) w += isWide(ch) ? 1 : mono ? 0.6 : 0.55;
  return w * size;
}

/** 文字盒（考虑 text-anchor），用于出界校验 */
export function textBox(el) {
  const size = el.size ?? 11;
  const w = estimateTextWidth(el.s, size, el.mono);
  const anchor = el.anchor ?? 'start';
  const x0 = anchor === 'middle' ? el.x - w / 2 : anchor === 'end' ? el.x - w : el.x;
  const ascent = size * 0.82;
  return { x0, x1: x0 + w, y0: el.y - ascent, y1: el.y + size * 0.24 };
}

/* -------------------------------- 布局预设 -------------------------------- */

const WIDE = {
  width: 900,
  survivalHeight: 320,
  stripHeight: 340,
  survival: { L: 54, R: 26, T: 22, B: 46 },
  strip: { L: 54, R: 76, T: 46, B: 46 },
  lanes: 9,
  laneGap: 12,
  dotR: 4.8,
  markerR: 6,
};

/**
 * 紧凑布局：给小程序用。
 *
 * 关键点：**不是把 900px 的图等比缩小**。等比缩到 345px 后，11px 的图内文字
 * 会变成 4px，等于没有文字。所以这里按目标宽度重新排版，字号基本不缩。
 */
export function compactLayout(opts = {}) {
  const width = Math.round(opts.width ?? 345);
  const k = Math.min(1, width / 340);
  return {
    width,
    survivalHeight: Math.round(opts.survivalHeight ?? 208),
    stripHeight: Math.round(opts.stripHeight ?? 230),
    survival: { L: 38, R: 12, T: 32, B: 40 },
    strip: { L: 38, R: 52, T: 46, B: 40 },
    lanes: 9,
    laneGap: 12,
    dotR: 4.4,
    markerR: 5,
    fontK: k,
    compact: true,
  };
}

export const wideLayout = () => ({ ...WIDE, fontK: 1, compact: false });

const pickLayout = (opts) => {
  if (opts.layout === 'compact') return compactLayout(opts);
  return { ...wideLayout(), width: Math.round(opts.width ?? 900) };
};

/* ------------------------------- 公共小工具 ------------------------------- */

const sortedOf = (data) =>
  data?.sorted?.length
    ? data.sorted
    : [...(data?.gapDays ?? [])].sort((a, b) => a - b);

const pctInt = (p) => Math.round((p ?? 0) * 100);

/* ============================== 生存曲线 ============================== */

/**
 * 等待生存曲线：到第 X 天为止，历史上百分之多少的重置已经发生。
 *
 * 分母始终是全部间隔；超过 xMax 的部分不落在具体刻度上，用虚线尾巴表示
 * 「长于 14 天」，避免被读成「恰好卡在第 14 天」。
 */
export function survivalScene(data, opts = {}) {
  const L0 = pickLayout(opts);
  const W = L0.width;
  const H = opts.height ?? L0.survivalHeight;
  const P = L0.survival;
  const k = L0.fontK;
  const iw = W - P.L - P.R;
  const ih = H - P.T - P.B;
  const axisFont = 11 * k;
  const lblFont = 11.5 * k;
  const xMax = 14;

  const X = (d) => P.L + (Math.min(d, xMax) / xMax) * iw;
  const Y = (p) => P.T + ih - Math.max(0, Math.min(1, p)) * ih;

  const sorted = sortedOf(data);
  const n = sorted.length;
  const el = [];

  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const xTicks = [0, 1, 2, 3, 5, 7, 10, 14];

  for (const p of yTicks) el.push(line(P.L, Y(p), P.L + iw, Y(p), { stroke: PALETTE.line, w: 1 }));
  for (const p of yTicks) {
    el.push(
      text(P.L - 8, Y(p) + 4, `${Math.round(p * 100)}%`, {
        anchor: 'end',
        fill: PALETTE.mist,
        size: axisFont,
        mono: true,
      })
    );
  }
  for (const d of xTicks) {
    el.push(
      text(X(d), H - P.B + 18, String(d), {
        anchor: 'middle',
        fill: PALETTE.mist,
        size: axisFont,
        mono: true,
      })
    );
  }
  el.push(
    text(P.L + iw / 2, H - 6, '距上次重置的天数', { anchor: 'middle', fill: PALETTE.mist, size: axisFont })
  );

  const steps = sorted.map((v, i) => ({
    d: Math.min(v, xMax),
    p: (i + 1) / n,
    capped: v > xMax,
  }));
  const solid = steps.filter((s) => !s.capped);
  const cappedCount = steps.length - solid.length;

  const line_ = [[P.L, Y(0)]];
  let prevY = Y(0);
  for (const s of solid) {
    line_.push([X(s.d), prevY], [X(s.d), Y(s.p)]);
    prevY = Y(s.p);
  }
  line_.push([X(xMax), prevY]);
  const area = [...line_, [X(xMax), Y(0)], [P.L, Y(0)]];

  el.push(
    poly(area, {
      grad: { color: PALETTE.lan, a0: 0.18, a1: 0, y0: Y(1), y1: Y(0) },
    })
  );
  el.push(poly(line_, { stroke: PALETTE.lan, w: 2, lineJoin: 'round' }));

  if (cappedCount) {
    el.push(
      poly([[X(xMax), prevY], [X(xMax), Y(1)]], {
        stroke: PALETTE.cinnabar,
        w: 1.8,
        dash: [4, 4],
      })
    );
    el.push(
      text(
        X(xMax) - 8,
        Y(0.97),
        L0.compact
          ? `>14 天 ×${cappedCount}`
          : `${cappedCount} 次长于 14 天（最长 ${(data.longest ?? 0).toFixed(1)} 天）`,
        {
          anchor: 'end',
          fill: PALETTE.cinnabar,
          size: lblFont,
          weight: 400,
        }
      )
    );
  }

  if (n) {
    el.push(
      line(X(data.median), P.T, X(data.median), P.T + ih, {
        stroke: PALETTE.mist,
        w: 1,
        dash: [2, 5],
        op: 0.7,
      })
    );
    el.push(
      text(X(data.median), P.T - 8, `中位 ${(data.median ?? 0).toFixed(1)} 天`, {
        anchor: 'middle',
        fill: PALETTE.mist,
        size: axisFont,
      })
    );
  }

  const curX = X(data.sinceDays);
  const curY = Y(data.pct);
  const anchor = curX > P.L + iw * 0.72 ? 'end' : 'start';
  const dx = anchor === 'end' ? -12 : 12;

  el.push(
    line(curX, P.T, curX, P.T + ih, { stroke: PALETTE.ink, w: 1, dash: [3, 4], op: 0.45 })
  );
  el.push(circle(curX, curY, L0.markerR, { fill: PALETTE.paper, stroke: PALETTE.ink, w: 2.5 }));

  // 标记点贴近顶部时标签会撞上「长于 14 天」的注释，这时改画在点下方
  const nearTop = curY - 14 < P.T + 14;
  el.push(
    text(curX + dx, nearTop ? curY + 22 : curY - 14, `现在 · ${pctInt(data.pct)}%`, {
      anchor,
      fill: PALETTE.ink2,
      size: lblFont,
      weight: 600,
    })
  );

  return { width: W, height: H, elements: el };
}

/* ============================== 点阵分布 ============================== */

/**
 * 每次间隔的离散分布。
 *
 * 横轴**线性等距** —— 曾用过平方根压缩让密集区可分辨，但那会让刻度间距不等、
 * 读者会按位置估读天数而出错。宁可将密集区画得拥挤，也不能误导。
 */
export function stripScene(data, opts = {}) {
  const L0 = pickLayout(opts);
  const W = L0.width;
  const H = opts.height ?? L0.stripHeight;
  const P = L0.strip;
  const k = L0.fontK;
  const iw = W - P.L - P.R;
  const ih = H - P.T - P.B;
  const axisFont = 11 * k;
  const lblFont = 11.5 * k;
  const xMax = 14;
  const mid = P.T + ih / 2;
  const lanes = L0.lanes;
  const laneGap = L0.laneGap;

  const X = (d) => P.L + (Math.min(Math.max(d, 0), xMax) / xMax) * iw;

  const gapDays = data?.gapDays ?? [];
  const median = data?.median ?? 0;
  const el = [];

  for (let d = 0; d <= xMax; d++) {
    el.push(
      line(X(d), P.T, X(d), P.T + ih, { stroke: PALETTE.line, w: 1, op: d % 5 === 0 ? 0.9 : 0.45 })
    );
    el.push(
      text(X(d), H - P.B + 18, String(d), {
        anchor: 'middle',
        fill: PALETTE.mist,
        size: axisFont,
        mono: true,
      })
    );
  }
  el.push(text(P.L + iw / 2, H - 6, '间隔天数', { anchor: 'middle', fill: PALETTE.mist, size: axisFont }));
  el.push(line(P.L, mid, P.L + iw, mid, { stroke: PALETTE.line, w: 1 }));

  const ordered = [...gapDays].sort((a, b) => a - b);
  const dots = ordered.map((d, i) => ({
    x: X(d),
    y: mid + ((i % lanes) - (lanes - 1) / 2) * laneGap,
    capped: d > xMax,
    color: d >= 30 ? PALETTE.cinnabar : d > median ? PALETTE.mist : PALETTE.lan,
  }));

  for (const d of dots) {
    if (d.capped) continue;
    el.push(circle(d.x, d.y, L0.dotR, { fill: d.color, op: 0.85 }));
  }

  const capped = dots.filter((d) => d.capped);
  if (capped.length) {
    const colX = X(xMax) + (L0.compact ? 16 : 20);
    const span = (capped.length - 1) * (L0.compact ? 13 : 13);
    const top = mid - span / 2;
    const bottom = mid + span / 2;

    el.push(line(colX, top, colX, bottom, { stroke: PALETTE.cinnabar, w: 1, op: 0.45 }));
    capped.forEach((_, i) => {
      el.push(
        circle(colX, top + i * 13, L0.dotR, { stroke: PALETTE.cinnabar, w: 1.8 })
      );
    });

    if (L0.compact) {
      el.push(
        text(colX, top - 10, `×${capped.length}`, {
          anchor: 'middle',
          fill: PALETTE.cinnabar,
          size: axisFont,
          mono: true,
        })
      );
      el.push(
        text(colX + 8, bottom + 18, `最长 ${(data?.longest ?? 0).toFixed(1)} 天`, {
          anchor: 'end',
          fill: PALETTE.cinnabar,
          size: axisFont,
        })
      );
    } else {
      el.push(
        text(
          P.L + 8,
          P.T + 10,
          `另有 ${capped.length} 次超过 14 天（最长 ${(data?.longest ?? 0).toFixed(1)} 天），单独排在右侧`,
          { anchor: 'start', fill: PALETTE.cinnabar, size: axisFont }
        )
      );
    }
  }

  el.push(
    line(X(median), P.T, X(median), P.T + ih, {
      stroke: PALETTE.mist,
      w: 1,
      dash: [2, 5],
      op: 0.7,
    })
  );
  el.push(
    text(X(median), P.T - (L0.compact ? 10 : 10), `中位 ${median.toFixed(1)} 天`, {
      anchor: 'middle',
      fill: PALETTE.mist,
      size: axisFont,
    })
  );

  const curX = X(data?.sinceDays ?? 0);
  el.push(
    line(curX, P.T - 4, curX, P.T + ih + 8, {
      stroke: PALETTE.ink,
      w: 1.5,
      dash: [3, 4],
    })
  );
  el.push(circle(curX, P.T - 4, 3, { fill: PALETTE.ink }));
  el.push(
    text(curX, P.T - (L0.compact ? 24 : 16), `现在 ${(data?.sinceDays ?? 0).toFixed(1)} 天`, {
      anchor: 'middle',
      fill: PALETTE.ink2,
      size: axisFont,
      weight: 600,
    })
  );

  return { width: W, height: H, elements: el };
}

/* ------------------------------- 自检工具 ------------------------------- */

/** 场景内所有元素的包围盒，用于「坐标越界」自动校验 */
export function sceneBounds(scene) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const put = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const e of scene.elements) {
    if (e.k === 'line') {
      put(e.x1, e.y1);
      put(e.x2, e.y2);
    } else if (e.k === 'circle') {
      put(e.cx - e.r, e.cy - e.r);
      put(e.cx + e.r, e.cy + e.r);
    } else if (e.k === 'poly') {
      for (const [x, y] of e.pts) put(x, y);
    } else if (e.k === 'text') {
      const b = textBox(e);
      put(b.x0, b.y0);
      put(b.x1, b.y1);
    }
  }
  return { minX, minY, maxX, maxY };
}
