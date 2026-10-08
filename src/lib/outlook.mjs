/**
 * 预测总览（outlook）—— 把「下一次重置预计什么时候 / 可不可信 / 凭什么」算成一份数据。
 *
 * 为什么单独一层：这三件事原来分散在三个地方各判一次（网页的 `renderSignal`、
 * 小程序的 `buildSignal`、以及回测表），于是「页面在讲哪一件事」取决于读者自己拼。
 * 本页要的是**结论优先**，那就必须先有一个唯一的结论对象，两端只负责画。
 *
 * ⚠ 这个系统里同时存在**两种性质完全不同的预测**，本模块的首要职责是把它们分清楚：
 *
 *   · `announced`（有公告）—— Tibo 发过推文，窗口是他给的。ETA = **公告窗口开启时刻**，
 *     这是一个**可核对的承诺**，依据是那条推文。
 *   · `model`（无公告）—— 没有任何公告，ETA = **历史节奏的中位推算**。
 *     这是一个**区间估计**，必须带 80% 区间一起出现，绝不允许只给一个时刻。
 *
 * 两者共用一张卡，但 `etaKind` 不同、`etaNote` 不同、置信度的依据也不同。
 * 把 `model` 档说成「预计 10.10 13:48 重置」而不给区间，就是拿估计冒充承诺。
 *
 * 能力边界（本模块刻意不做的事）：
 *   · 不产出「今天会不会重置」这种是/否判断 —— 7 天区分度实测与盲猜持平
 *     （`skill.score ≈ 0`），那种判断没有区分力。
 *   · 不写关于模型自身的散文。披露一律走数字：覆盖率、样本量、重采样波动。
 */

const DAY = 86_400_000;

/* ------------------------------ 判据常量 ------------------------------ */

/** 「硬承诺」的粒度档：到日或到时刻才算把话说死。只到「周」的另算一档。 */
export const TIGHT_PRECISION = ['instant', 'day', 'evening'];

/** 统计档判「中」置信度需要的样本外回测样本量下限 */
export const CONF_MIN_BACKTEST_N = 30;
/** 80% 覆盖率与名义值之间允许的偏差 */
export const CONF_COV_TOLERANCE = 0.08;
/** 重采样后中位估计的相对波动上限：(hi − lo) / mid */
export const CONF_MAX_MEDIAN_REL = 1.5;

export const STATUS_LABEL = { confirmed: '已确认', likely: '高概率', watching: '观察中' };
export const CONFIDENCE_LABEL = { high: '高', medium: '中', low: '低' };
export const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

/** 状态徽章的说明句（事实陈述，不是自我评价） */
export const STATUS_NOTE = {
  confirmed: 'Tibo 已把时间说死到具体时刻',
  likely: 'Tibo 已预告，但只给到「一周内」这种粒度',
  watching: '没有公告，按历史节奏推算',
};

/* ------------------------------ 工具 ------------------------------ */

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/* ------------------------------ 主函数 ------------------------------ */

/**
 * @param {{chart:object, prediction:object, signals:object, now:number}} input
 * @returns {object|null} 数据不足时返回 null（调用方据此不渲染总览，而不是画一张空卡）
 */
export function buildOutlook({ chart, prediction, signals, now }) {
  const at = finite(now) ? now : Date.now();
  const p = prediction?.prediction;
  if (!chart || !p || !finite(p.q50)) return null;

  const forecasts = (signals?.forecasts ?? []).filter((f) => finite(f?.window?.fromTs));
  const f = forecasts[0] ?? null;

  // 重采样对中位估计的相对波动。它衡量的是「换一批样本，这个中位数还站得住吗」。
  // 必须在两个分支**之前**算出来 —— else 分支要用它判置信度。
  const med = prediction?.uncertainty?.medianDays;
  const rel =
    med && finite(med.lo) && finite(med.hi) && finite(med.mid) && med.mid > 0
      ? (med.hi - med.lo) / med.mid
      : null;

  // 「置信度的三个分量各自过没过」——在分支**之前**算好，两个分支共用同一份结果。
  //
  // 为什么必须由本模块算、而不是让渲染层自己再判一遍：这三个阈值（样本量下限、
  // 覆盖率容差、重采样波动上限）是**置信度这个词的定义**。渲染层复制一份判据，
  // 就等于让「卡上写的达标项」和「实际决定档位的项」变成两个可以各自漂移的东西 ——
  // 而依据卡的结语正是拿它当句子主语的（「…都在容差内，置信度因此给出「中」」）。
  // 判据漂了，那句话就在页面上说一句不成立的话。
  const nOk = finite(prediction?.calibration?.n) && prediction.calibration.n >= CONF_MIN_BACKTEST_N;
  // ⚠ 用 `covBand80`（双侧 [q10, q90] 的实测覆盖率），**不是** `cov80`。
  // `cov80` 是单侧上界 P(T ≤ q80) 的覆盖率 —— 拿它论证上面那个双侧区间可不可信，
  // 是换个口径讲另一件事。两者在本数据集上恰好接近，但那是巧合，不是理由。
  const covOk =
    finite(prediction?.calibration?.covBand80) &&
    Math.abs(prediction.calibration.covBand80 - 0.8) <= CONF_COV_TOLERANCE;
  const relOk = finite(rel) && rel <= CONF_MAX_MEDIAN_REL;
  const checks = {
    nOk,
    covOk,
    relOk,
    /** 三项里未达标的**项数**。结语要写「有 N 项未达标」，就得有一个真的数出来。 */
    failed: [nOk, covOk, relOk].filter((ok) => !ok).length,
  };

  let etaAt;
  let etaKind;
  let band = null;
  let status;
  let level;
  let reason;

  if (f) {
    etaAt = f.window.fromTs;
    etaKind = 'announced';
    band = finite(f.window.toTs) ? { fromAt: f.window.fromTs, toAt: f.window.toTs } : null;

    const hard = (f.counts?.hard ?? 0) >= 1;
    const tight = TIGHT_PRECISION.includes(f.precision);
    // 公告档的判据是**公告本身的明确程度**，不是上表那三项统计。两个标记同样由
    // 本模块给出，渲染层只读 —— 「别拿 A 的理由解释 B 的结论」这条只能有一个来源。
    checks.hard = hard;
    checks.tight = tight;
    if (tight && hard) {
      status = 'confirmed';
      level = 'high';
      reason = 'hard-date';
    } else if (hard) {
      status = 'likely';
      level = 'medium';
      reason = 'hard-vague';
    } else {
      status = 'likely';
      level = 'medium';
      reason = 'soft-only';
    }
  } else {
    // 中位推算：`sinceDays` 与 `q50` 出自同一个 now，所以 now + q50 天就是那个时刻。
    // 取整到毫秒 —— 分位数是浮点天数，直接相加会得到小数毫秒，进 JSON 后是个脏值。
    etaAt = Math.round(at + p.q50 * DAY);
    etaKind = 'model';
    status = 'watching';

    // 80% 双侧区间必须是 q10–q90（0.9 − 0.1 = 0.8）。
    // 曾经这里退到 q25 —— 那是 65% 区间，标成「80%」就是在页面上说一句当时并不成立的话
    // （AGENTS.md「用户可见文案的红线」第 4 条）。实测 walk-forward：q10–q90 覆盖 83.3%，
    // q25–q90 只有 68.3%。所以 `q10` 由 `predict.mjs` 正式产出，这里不再回退：
    // 真缺了就让它变成 `NaN` 而被上游断言抓住，而不是静默降级成一个说得过去但错的区间。
    band = { fromAt: at + p.q10 * DAY, toAt: at + p.q90 * DAY };

    level = nOk && covOk && relOk ? 'medium' : 'low';
    reason = nOk && covOk && relOk ? 'calibrated' : 'insufficient';
  }

  checks.kind = etaKind;
  checks.covBand80 = prediction?.calibration?.covBand80 ?? null;

  return {
    now: at,
    /** 结论 */
    etaAt,
    etaKind,
    etaDate: new Date(etaAt).toISOString(),
    etaNote: etaKind === 'announced' ? '公告窗口开启时刻' : '历史节奏的中位推算',
    band,

    status,
    statusLabel: STATUS_LABEL[status],
    statusNote: STATUS_NOTE[status],

    confidence: level,
    confidenceLabel: CONFIDENCE_LABEL[level],
    confidenceRank: CONFIDENCE_RANK[level],
    confidenceReason: reason,

    /**
     * 三项判据的**逐项结果**（`nOk` / `covOk` / `relOk` / `failed`）。
     *
     * 依据卡要把它们写成「…都在容差内，所以置信度给出「中」」这样一个句子，
     * 而那个句子的主语必须与实际决定档位的东西是同一批 —— 所以这里给的是
     * **判据本身**，不是让渲染层照着阈值再判一遍（见本文件上方那段注释）。
     * 公告档还会带上 `hard` / `tight`（公告档的判据），`kind` 标明是哪一档。
     */
    checks,

    /**
     * 置信度的三个分量。**必须与结论同屏**：它是「这个结论凭什么可信」的可核对部分，
     * 拿掉之后「置信度：中」就成了一句没有根据的自我评价。
     */
    evidence: {
      backtestN: prediction?.calibration?.n ?? null,
      cov50: prediction?.calibration?.cov50 ?? null,
      /** 单侧上界覆盖率 P(T ≤ q80)：说明「上界会不会被顶破」 */
      cov80: prediction?.calibration?.cov80 ?? null,
      cov90: prediction?.calibration?.cov90 ?? null,
      /** 双侧区间 [q10, q90] 的实测覆盖率：**这才是上面那个 band 自己的成绩** */
      covBand80: prediction?.calibration?.covBand80 ?? null,
      medianRel: rel,
      thresholds: {
        minBacktestN: CONF_MIN_BACKTEST_N,
        covTolerance: CONF_COV_TOLERANCE,
        maxMedianRel: CONF_MAX_MEDIAN_REL,
      },
    },

    /**
     * 一句话依据摘要的**原料**（不在这里拼句子）。
     *
     * 时长文案在本仓库有四处实现且被 `test-shared.mjs` 对拍，第五处会被判漂移 ——
     * 所以这里只给数字，句子由各端用它自己的时长口径拼。两端各一句，措辞可能不同，
     * 但**数字一定同源**。
     */
    brief: {
      kind: etaKind,
      // announced 档
      announcedHard: f?.counts?.hard ?? 0,
      announcedSoft: f?.counts?.soft ?? 0,
      announcedAt: f?.createdAt ?? null,
      // model 档
      intervals: prediction?.model?.nIntervals ?? null,
      histMedian: chart.median,
      sinceDays: chart.sinceDays,
      pct: chart.pct,
      // 无公告时「扫了多少条、一条都没命中」也是依据的一部分
      scanned: signals?.checkedTweets ?? null,
      hints: signals?.counts?.hint ?? null,
    },
  };
}
