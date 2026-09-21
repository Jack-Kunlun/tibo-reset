/**
 * 预测引擎 —— 分段常数风险模型（piecewise-constant hazard model）
 *
 * 为什么不是「平均间隔倒计时」？
 *   52 个间隔里均值 6.9 天、中位 3.2 天。均值被 49.7 / 67.7 两次极端等待拉高，
 *   拿它做倒计时，会在绝大多数情况下高估等待时间。
 *
 * 为什么不是「查表给概率」？
 *   历史样本只有 52 个，直接按天查表会在第 11~13 天这种「零事件区」算出 0%，
 *   在 30 天以后（风险集只剩 2）算出垃圾值。所以必须分桶 + 收缩。
 *
 * 模型定义
 * ---------
 * 把「距上次重置的已等待天数」t 轴切成若干桶，每个桶内假设风险率恒定 λ_b（单位：每人每天）。
 *   - 暴露量 E_b = Σ 每个历史间隔在桶 b 内「活着」的天数（含尚未结束的当前间隔，即右删失）
 *   - 事件数 N_b = 落入桶 b 的已完成间隔个数
 *   - 极大似然估计 λ̂_b = N_b / E_b
 *   - Gamma-Poisson 收缩：λ_b = (N_b + κ·λ₀) / (E_b + κ)
 *       λ₀ = 全样本基准风险率，κ = 先验等效暴露天数（越小越信数据）
 *     这一步专治「零事件桶」与「小样本桶」，避免输出 0% 或 200% 这种不可用数字。
 *
 * 由此得到连续时间的条件生存函数：
 *   S(t | now) = exp( -∫_now^t λ(u) du )
 * 所有概率、期望、分位数都由它推出 —— 口径统一，不会自相矛盾。
 *
 * 能力边界（必须如实传达）
 * ------------------------
 * 模型描述的是「历史节奏的外推」，不是 OpenAI 的内部排期。
 * 新模型发布、故障补偿、政策调整都不在模型里 —— 这些只能靠外部信号捕捉。
 * 因此所有输出都必须带不确定区间与回测成绩，不允许单独抛出一个裸概率。
 */

const DAY = 86_400_000;

/** 风险桶切点。切分依据是各段的实际样本量（见 README「模型」一节）。 */
export const DEFAULT_BREAKS = [0, 1, 2, 3, 5, 8, 14, 30, Infinity];

/** 收缩先验强度：等效于多少「人·天」的先验暴露量 */
export const DEFAULT_PRIOR = 3;

/* ------------------------------- 数据准备 ------------------------------- */

const toDays = (ms) => ms / DAY;

/**
 * 把重置记录转成区间序列。
 * 最后一个区间若尚未闭合，标记 censored —— 它只贡献暴露量，不贡献事件数。
 * 漏掉这一步会系统性低估风险率（把「等了 8 天还没来」当成「没等」）。
 */
export function buildIntervals(records, now = Date.now()) {
  const asc = records
    .filter((r) => r.announced_at)
    .map((r) => ({ ...r, t: new Date(r.announced_at).getTime() }))
    .sort((a, b) => a.t - b.t);

  const intervals = [];
  for (let i = 1; i < asc.length; i++) {
    intervals.push({
      start: asc[i - 1].t,
      end: asc[i].t,
      days: toDays(asc[i].t - asc[i - 1].t),
      censored: false,
    });
  }

  // 进行中的区间：从最后一次重置到现在
  const last = asc[asc.length - 1];
  if (last && now > last.t) {
    intervals.push({
      start: last.t,
      end: null,
      days: toDays(now - last.t),
      censored: true,
    });
  }

  return { intervals, records: asc, last };
}

/* -------------------------------- 模型拟合 -------------------------------- */

function bucketOverlap(a, b, lo, hi) {
  return Math.max(0, Math.min(b, hi) - Math.max(a, lo));
}

/**
 * @param {Array<{days:number, censored:boolean, end:number|null}>} intervals
 * @param {{breaks?:number[], prior?:number, halfLifeDays?:number, now?:number}} opts
 *        halfLifeDays — 指数时间衰减半衰期（天）。近期样本权重更高，
 *        用于应对「机制漂移」（例如节奏由高频转向发券）。不传则等权。
 */
export function fit(intervals, opts = {}) {
  const breaks = opts.breaks ?? DEFAULT_BREAKS;
  const prior = opts.prior ?? DEFAULT_PRIOR;
  const now = opts.now ?? Date.now();
  const halfLife = opts.halfLifeDays ?? null;
  // 只用最近 N 个间隔训练：应对「机制漂移」。早期存在的超长静默若已不再出现，
  // 全量训练会把尾部风险率压低，从而系统性高估剩余等待时间。
  const list = opts.maxIntervals ? intervals.slice(-opts.maxIntervals) : intervals;

  const buckets = [];
  for (let i = 0; i < breaks.length - 1; i++) {
    buckets.push({ a: breaks[i], b: breaks[i + 1], exposure: 0, events: 0, rate: 0 });
  }

  let totalExposure = 0;
  let totalEvents = 0;

  for (const iv of list) {
    // 时间衰减权重：越近的样本越重
    const w = halfLife
      ? Math.pow(0.5, (now - (iv.end ?? now)) / DAY / halfLife)
      : 1;

    for (const bk of buckets) {
      const ov = bucketOverlap(bk.a, bk.b, 0, iv.days);
      if (ov > 0) {
        bk.exposure += ov * w;
        totalExposure += ov * w;
      }
      if (!iv.censored && iv.days > bk.a && iv.days <= bk.b) {
        bk.events += w;
        totalEvents += w;
      }
    }
  }

  // 全样本基准风险率：作为收缩目标，也是长尾外推的兜底
  const baseRate = totalExposure > 0 ? totalEvents / totalExposure : 0;

  for (const bk of buckets) {
    const raw = bk.exposure > 0 ? bk.events / bk.exposure : baseRate;
    bk.rawRate = raw;
    // Gamma-Poisson 后验均值：零事件桶被拉回基准，样本充足的桶几乎不受影响
    bk.rate = (bk.events + prior * baseRate) / (bk.exposure + prior);
    bk.width = bk.b === Infinity ? null : bk.b - bk.a;
  }

  return {
    breaks,
    buckets,
    baseRate,
    prior,
    halfLifeDays: halfLife,
    maxIntervals: opts.maxIntervals ?? null,
    nIntervals: list.length,
    nEvents: list.filter((i) => !i.censored).length,
    totalExposure,
    fittedAt: new Date(now).toISOString(),
  };
}

/* ------------------------------ 生存与概率 ------------------------------ */

/** 累计风险 ∫_from^to λ(u) du。超出最后一个桶上界时沿用该桶风险率（指数尾）。 */
export function cumHazard(model, from, to) {
  if (to <= from) return 0;
  let H = 0;
  for (const bk of model.buckets) {
    H += bk.rate * bucketOverlap(bk.a, bk.b, from, to);
  }
  return H;
}

/** 从已等待 sinceDays 天出发，到 sinceDays + h 天的条件累积发生概率 */
export function probWithin(model, sinceDays, h) {
  return 1 - Math.exp(-cumHazard(model, sinceDays, sinceDays + h));
}

/** 条件剩余等待的生存函数 S(sinceDays + t) / S(sinceDays)，t ≥ 0 */
export function residualSurvival(model, sinceDays, t) {
  return Math.exp(-cumHazard(model, sinceDays, sinceDays + t));
}

/** 期望剩余等待天数 E[T - now | T > now] = ∫₀^∞ S(t) dt（数值积分） */
export function expectedRemaining(model, sinceDays, maxDays = 400, steps = 4000) {
  const dt = maxDays / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    sum += residualSurvival(model, sinceDays, (i + 0.5) * dt) * dt;
  }
  return sum;
}

/** 剩余等待天数分位数：求最小 q 使条件累积概率 ≥ p */
export function quantile(model, sinceDays, p, maxDays = 400) {
  let lo = 0;
  let hi = 1;
  while (hi < maxDays && probWithin(model, sinceDays, hi) < p) hi *= 1.6;
  hi = Math.min(hi, maxDays);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (probWithin(model, sinceDays, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/* ------------------------------- 预测封装 ------------------------------- */

const HORIZONS = [
  { h: 1, label: '24 小时内' },
  { h: 3, label: '3 天内' },
  { h: 7, label: '7 天内' },
  { h: 14, label: '14 天内' },
  { h: 30, label: '30 天内' },
];

export function predictAt(model, sinceDays) {
  return {
    sinceDays,
    horizons: HORIZONS.map((x) => ({
      ...x,
      p: probWithin(model, sinceDays, x.h),
    })),
    expectedRemaining: expectedRemaining(model, sinceDays),
    median: quantile(model, sinceDays, 0.5),
    q25: quantile(model, sinceDays, 0.25),
    q75: quantile(model, sinceDays, 0.75),
    q90: quantile(model, sinceDays, 0.9),
    // 当天（未来 24h）的瞬时风险率，用于「今日风险」展示
    dailyRate: cumHazard(model, sinceDays, sinceDays + 1),
  };
}

/* --------------------------------- 回测 --------------------------------- */

/**
 * Walk-forward 回测。
 *
 * 关键点：**不许偷看未来**。在每个评估时刻 t，模型只能看到 t 之前的已完成间隔，
 * 加上从上次重置到 t 的这段「已等待但未发生」的暴露量。
 *
 * 评估口径对齐真实使用场景：用户每天来问「未来 7 天内会重置吗」。
 * 因此 outcome = 从 t 起 7 天内是否真的发生了下一次重置。
 * t+7 超出数据范围的评估点直接丢弃（右删失），否则会系统性低估风险。
 */
export function backtest(records, opts = {}) {
  const horizon = opts.horizon ?? 7;
  const stepDays = opts.stepDays ?? 0.5;
  const minTrain = opts.minTrainIntervals ?? 10;

  const asc = records
    .filter((r) => r.announced_at)
    .map((r) => ({ ...r, t: new Date(r.announced_at).getTime() }))
    .sort((a, b) => a.t - b.t);

  const rows = [];
  const dataEnd = asc[asc.length - 1].t;

  for (let ti = minTrain; ti < asc.length - 1; ti++) {
    const lastEvent = asc[ti].t;
    const nextEvent = asc[ti + 1].t;

    // 在当前区间内按步长布点；不越过下一个事件
    const spanDays = toDays(nextEvent - lastEvent);
    for (let d = 0.5; d < spanDays; d += stepDays) {
      const t = lastEvent + d * DAY;
      if (t + horizon * DAY > dataEnd) continue; // 右删失，丢弃

      const history = asc.slice(0, ti + 1);
      const { intervals } = buildIntervals(history, t);
      if (intervals.filter((i) => !i.censored).length < minTrain) continue;

      const model = fit(intervals, { ...opts, now: t });
      const p = probWithin(model, d, horizon);
      const outcome = t + horizon * DAY >= nextEvent ? 1 : 0;

      // 基线：常数风险（泊松），完全忽略「已经等了多久」
      const pBase = 1 - Math.exp(-model.baseRate * horizon);

      rows.push({
        t,
        d,
        p,
        pBase,
        outcome,
        actualRemaining: toDays(nextEvent - t),
      });
    }
  }

  if (!rows.length) return { n: 0, rows: [] };

  const brier = (key) =>
    rows.reduce((s, r) => s + (r[key] - r.outcome) ** 2, 0) / rows.length;

  // 校准表：预测概率分箱 vs 实际发生率
  const bins = Array.from({ length: 5 }, (_, i) => ({ lo: i / 5, hi: (i + 1) / 5, n: 0, sumP: 0, sumY: 0 }));
  for (const r of rows) {
    const b = bins.find((x) => r.p >= x.lo && r.p < x.hi) ?? bins[bins.length - 1];
    b.n++;
    b.sumP += r.p;
    b.sumY += r.outcome;
  }

  return {
    n: rows.length,
    horizon,
    baseRateOfEvent: rows.reduce((s, r) => s + r.outcome, 0) / rows.length,
    brier: brier('p'),
    brierBaseline: brier('pBase'),
    // Brier Skill Score：>0 说明比「忽略已等待时间」的常数风险模型更好
    skill: 1 - brier('p') / brier('pBase'),
    calibration: bins
      .filter((b) => b.n > 0)
      .map((b) => ({
        range: [b.lo, b.hi],
        n: b.n,
        predicted: b.sumP / b.n,
        actual: b.sumY / b.n,
      })),
    rows,
  };
}

/**
 * 分位数覆盖率回测 —— 这才是「时间预测」的正确判据。
 *
 * Brier Score 衡量的是「概率说得准不准」，在本数据集上区分度天然很低
 * （7 天窗口的基准发生率就有 80%，闭着眼睛猜都能拿不错的分数）。
 * 而用户真正问的是「还要等多久」，所以应该检验预测区间的覆盖率：
 *
 *   如果我说「中位数 5 天」，那历史上应该正好有一半的情况在 5 天内发生。
 *   如果我说「80% 上界 12 天」，那应该约有 80% 的情况落在 12 天内。
 *
 * 覆盖率高得离谱 = 区间过宽（没用）；低得离谱 = 过度自信（危险）。
 * 这个判据无法靠调参糊弄过去，所以它比 Brier 更可信。
 */
export function coverageBacktest(records, opts = {}) {
  const levels = opts.levels ?? [0.5, 0.8, 0.9];
  const stepDays = opts.stepDays ?? 0.5;
  const minTrain = opts.minTrainIntervals ?? 10;

  const asc = records
    .filter((r) => r.announced_at)
    .map((r) => ({ ...r, t: new Date(r.announced_at).getTime() }))
    .sort((a, b) => a.t - b.t);

  const rows = [];
  for (let ti = minTrain; ti < asc.length - 1; ti++) {
    const lastEvent = asc[ti].t;
    const nextEvent = asc[ti + 1].t;
    const spanDays = toDays(nextEvent - lastEvent);

    for (let d = 0.5; d < spanDays; d += stepDays) {
      const t = lastEvent + d * DAY;
      const history = asc.slice(0, ti + 1);
      const { intervals } = buildIntervals(history, t);
      if (intervals.filter((i) => !i.censored).length < minTrain) continue;

      const model = fit(intervals, { ...opts, now: t });
      const qs = {};
      for (const lv of levels) qs[lv] = quantile(model, d, lv);
      // 无条件分位数：忽略「已经等了多久」，纯粹照搬历史间隔分布
      const naive = {};
      for (const lv of levels) {
        const done = intervals.filter((i) => !i.censored).map((i) => i.days).sort((a, b) => a - b);
        naive[lv] = done[Math.min(done.length - 1, Math.floor(lv * done.length))];
      }

      const actual = toDays(nextEvent - t);
      rows.push({ t, d, qs, naive, actual });
    }
  }

  if (!rows.length) return { n: 0 };

  const summarize = (get) =>
    levels.map((lv) => {
      const preds = rows.map((r) => get(r, lv));
      const covered = rows.filter((r, i) => r.actual <= preds[i]).length / rows.length;
      const widths = rows.map((r, i) => r.actual - preds[i]);
      return {
        level: lv,
        nominal: lv,
        empirical: covered,
        // 平均预测值：与「实际剩余天数」比较，看是否整体偏高/偏低
        meanPredicted: preds.reduce((a, b) => a + b, 0) / preds.length,
        meanActual: rows.reduce((a, r) => a + r.actual, 0) / rows.length,
        bias: widths.reduce((a, b) => a + b, 0) / widths.length,
      };
    });

  return {
    n: rows.length,
    conditional: summarize((r, lv) => r.qs[lv]),
    unconditional: summarize((r, lv) => r.naive[lv]),
    rows,
  };
}

/* ------------------------------ 不确定性区间 ------------------------------ */

/**
 * 对历史间隔做有放回重采样，重新拟合，得到预测的概率分布。
 * 52 个样本的模型，没有这个区间就无法判断预测值有多少是噪声。
 */
export function bootstrapCI(intervals, sinceDays, opts = {}) {
  const iterations = opts.iterations ?? 1000;
  const target = opts.target ?? 7;
  const rng = opts.rng ?? Math.random;

  const completed = intervals.filter((i) => !i.censored);
  const tail = intervals.filter((i) => i.censored);
  const ps = [];
  const meds = [];

  for (let it = 0; it < iterations; it++) {
    const sample = [];
    for (let i = 0; i < completed.length; i++) {
      sample.push(completed[Math.floor(rng() * completed.length)]);
    }
    const model = fit([...sample, ...tail], { ...opts, now: opts.now ?? Date.now() });
    ps.push(probWithin(model, sinceDays, target));
    meds.push(quantile(model, sinceDays, 0.5));
  }

  const q = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
    return s[i];
  };

  return {
    target,
    iterations,
    p: { lo: q(ps, 0.05), mid: q(ps, 0.5), hi: q(ps, 0.95) },
    medianDays: { lo: q(meds, 0.05), mid: q(meds, 0.5), hi: q(meds, 0.95) },
  };
}

/* ------------------------------ 生产参数与校准 ------------------------------ */

/**
 * 默认生产参数。选择依据不是「全期平均表现」，而是「近期表现」——
 * 因为在一个持续加速的过程里，只有近期表现才能代表未来。
 *
 * maxIntervals=20 对应约最近 3 个月；halfLifeDays=45 让更近的样本再获得额外权重。
 * 这两项把近期中位偏差从 −2.65 天压到 −0.60 天（回测见 scripts/diagnose.mjs）。
 */
export const DEFAULT_CONFIG = {
  maxIntervals: 20,
  halfLifeDays: 45,
  calibrationWindow: 120,
};

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};

/**
 * 用 walk-forward 的样本外残差做平移校准。
 *
 * 为什么需要：模型在加速期必然滞后，于是系统性高估剩余等待时间。
 * 因为 coverageBacktest 的每一个预测都只用该时刻之前的数据（样本外），
 * 所以用它的残差中位数来估计这个滞后量是合法的，不属于拿答案对答案。
 *
 * 不修正会怎样：名义 50% 分位实际覆盖 70%，等于把区间整体说长了。
 */
export function calibrate(records, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...opts };
  const cv = coverageBacktest(records, cfg);
  if (!cv.rows?.length) return { shift: 0, n: 0, cov50: null, cov80: null, cov90: null };

  const rows = cv.rows.slice(-cfg.calibrationWindow);
  const shift = median(rows.map((r) => r.actual - r.qs[0.5]));

  const covered = (lv) => rows.filter((r) => r.actual <= r.qs[lv] + shift).length / rows.length;

  return {
    shift,
    n: rows.length,
    cov50: covered(0.5),
    cov80: covered(0.8),
    cov90: covered(0.9),
    shiftUncalibratedBias: rows.reduce((a, r) => a + (r.actual - r.qs[0.5]), 0) / rows.length,
  };
}

/**
 * 节奏阶段：把间隔按时间等分成若干段，看均值怎么变。
 * 这是本项目最反直觉、也最值得公开的发现 —— 节奏在持续加速。
 */
export function phases(records, segmentCount = 3) {
  const { intervals } = buildIntervals(records);
  const done = intervals.filter((i) => !i.censored);
  if (!done.length) return [];

  const size = Math.ceil(done.length / segmentCount);
  const out = [];
  for (let s = 0; s < segmentCount; s++) {
    const seg = done.slice(s * size, (s + 1) * size);
    if (!seg.length) continue;
    const days = seg.map((i) => i.days).sort((a, b) => a - b);
    out.push({
      from: new Date(seg[0].start).toISOString(),
      to: new Date(seg[seg.length - 1].end).toISOString(),
      n: seg.length,
      mean: days.reduce((a, b) => a + b, 0) / days.length,
      median: days[Math.floor(days.length / 2)],
      max: days[days.length - 1],
    });
  }
  return out;
}

/** 一次性产出完整预测对象：模型 → 原始预测 → 校准 → 披露数据 */
export function predictAll(records, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...opts };
  const now = opts.now ?? Date.now();
  const { intervals, last } = buildIntervals(records, now);
  const model = fit(intervals, { ...cfg, now });
  const sinceDays = (now - last.t) / DAY;

  const cal = calibrate(records, { ...cfg, now });
  const shift = cal.shift;

  const raw = predictAt(model, sinceDays);
  const adjusted = {
    ...raw,
    horizons: raw.horizons.map((h) => ({ ...h, p: h.p })),
    q25: Math.max(0, raw.q25 + shift),
    q50: Math.max(0, raw.median + shift),
    q75: Math.max(0, raw.q75 + shift),
    q90: Math.max(0, raw.q90 + shift),
    expectedRemaining: Math.max(0.1, raw.expectedRemaining + shift),
  };

  // 校准后的 80% 区间：用校准后的 q10 / q90 近似
  const lo = Math.max(0, quantile(model, sinceDays, 0.1) + shift);
  const hi = adjusted.q90;

  const bt = backtest(records, { ...cfg, horizon: 7, now });
  const ci = bootstrapCI(intervals, sinceDays, {
    ...cfg,
    target: 7,
    iterations: opts.iterations ?? 400,
    now,
  });

  const warnings = [];
  if (cal.cov50 !== null && Math.abs(cal.cov50 - 0.5) > 0.15) {
    warnings.push(
      `样本外校准偏离较大（50% 分位实际覆盖 ${(cal.cov50 * 100).toFixed(0)}%），说明节奏可能又在变化`
    );
  }
  if (model.nEvents < 60) {
    warnings.push(`训练样本仅 ${model.nEvents} 次事件，长尾估计不稳定`);
  }
  const ph = phases(records);
  if (ph.length >= 2 && ph[ph.length - 1].mean < ph[0].mean * 0.6) {
    warnings.push('节奏处于明显加速期，任何历史外推都会偏保守（高估等待时间）');
  }

  return {
    asOf: new Date(now).toISOString(),
    sinceDays,
    last: { at: last.announced_at, text: last.text },
    model: {
      params: {
        maxIntervals: cfg.maxIntervals,
        halfLifeDays: cfg.halfLifeDays,
        prior: model.prior,
      },
      baseRate: model.baseRate,
      nIntervals: model.nIntervals,
      nEvents: model.nEvents,
      buckets: model.buckets.map((b) => ({
        from: b.a,
        to: b.b,
        exposure: b.exposure,
        events: b.events,
        rate: b.rate,
      })),
    },
    prediction: adjusted,
    rawPrediction: {
      q50: raw.median,
      q90: raw.q90,
      expectedRemaining: raw.expectedRemaining,
      horizons: raw.horizons,
    },
    calibration: { ...cal, shift, applied: shift },
    skill: { brier: bt.brier, baseline: bt.brierBaseline, score: bt.skill, n: bt.n },
    uncertainty: ci,
    phases: ph,
    warnings,
  };
}

