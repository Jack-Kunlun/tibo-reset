/**
 * 重置信号识别 —— 从推文里判断「Tibo 的额度重置处于什么状态」。
 *
 * 这个模块存在的前置约束：**不能误报**。
 * 现有真实数据里就有一条
 *   「the main thing i was excited about launching this week will be next week instead」
 * —— 它含 "next week"，但讲的是**发布延期**，跟额度无关。
 * 如果把它标成「重置信号」，这个功能的可信度当场归零。
 *
 * 信号分四级：
 *
 *   explicit  重置意图 + 可解析的未来时间 → 明确预告，给出时间窗口
 *   occurred  **已经发生**的重置（「A reset…」/「reset all propagated」）→ 记录事实
 *   hint      只命中一半（有时间没意图，或有意圖没时间）→ 只作线索，不当信号展示
 *   none      其余
 *
 * 为什么要有 occurred：观测台要回答的第一个问题是「上次重置是什么时候」。
 * 早先的实现只找预告，把「已发生」当作「已完成的过去事件」丢进 none ——
 * 于是页面自相矛盾：下方「最近记录」里那条显眼地标着「普通重置」，
 * 上方信号区却说「没有检测到重置预告」。同一个事实，两套结论。
 *
 * 另外把「被排除但值得知道的」单独放进 rejected，供排查，不误导用户。
 *
 * 时间一律给出**两个时区**：推文的时间语境在发推者那边（默认太平洋时间），
 * 用户在中国。只给北京时间会丢信息，只给当地时间又看不懂。
 */

import { dualZone, partsIn, offsetHours } from './chart-data.js';

export const USER_ZONE = 'Asia/Shanghai';
export const SOURCE_ZONE = 'America/Los_Angeles'; // 公开报道称 Tibo 常驻旧金山，可配置
export const SOURCE_ZONE_LABEL = '太平洋时间';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * hints / rejected 两类进入 signal.json 的上限（纯体积保护）。
 *
 * 核心结论（explicit / occurred）**不设上限** —— 它们天然很少，
 * 而且任何一个都不该被丢掉。这个数字只用于「线索」和「被排除项」，
 * 触顶时会置 `truncated: true`，不静默。
 *
 * 方向：两个列表都是按发布时间**倒序**走到这里的，所以 `slice(0, N)`
 * 保留的是**最近的** N 条、丢掉最旧的。对 rejected 这样做是安全的 ——
 * 真正的重置信号走 explicit / occurred，而那两类全量保留。
 *
 * ⚠ 这不是「累积日志 + 淘汰最旧」。每轮 detectSignals 都在时间窗内**全量重算**，
 * 一条推文离开列表的原因是**滑出时间窗**，不是被淘汰。所以这个上限的真实约束是
 * 「窗内条数的峰值」，与历史总量无关 —— 提高它不会让文件随时间无限增长。
 *
 * 取 200（原 60）：2026-09-22 实测窗内被拒 62 条 / 60 天，要涨到 3 倍以上才会触顶。
 * 原值 60 是为「rejected 随小程序快照下发」定的，而同一天稍后的提交把 rejected
 * 从快照里整个摘掉了（见 scripts/build.mjs）—— 于是这个数字现在只保护
 * data/signal.json 这一个仓库文件，页面与小程序都不受它影响。
 */
const MAX_LISTED = 200;

/** 取「某天的某个钟点」在指定时区的 UTC 时刻。dayNum 是纯日历日序号，不受夏令时影响。 */
function at(dayNum, hh, mm, zone) {
  const c = ymdOf(dayNum);
  return zonedToTs(c.y, c.m, c.d, hh, mm, zone);
}

/* ------------------------------- 时间工具 ------------------------------- */

const dayNumOf = (y, m, d) => Date.UTC(y, m - 1, d) / DAY;
const ymdOf = (dayNum) => {
  const t = new Date(dayNum * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** 把「某时区的墙上时间」转成 UTC 时刻。循环两次足以收敛（含夏令时切换）。 */
function zonedToTs(y, m, d, hh, mm, zone) {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let ts = wall;
  for (let i = 0; i < 3; i++) {
    const off = offsetHours(new Date(ts).toISOString(), zone) * HOUR;
    const next = wall - off;
    if (next === ts) break;
    ts = next;
  }
  return ts;
}

const WEEKDAY_ISO = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** 推文时刻在发推者时区的「日历坐标」 */
function localParts(ts, zone) {
  const p = partsIn(new Date(ts).toISOString(), zone);
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    hh: Number(p.hour),
    mm: Number(p.minute),
    iso: WEEKDAY_ISO[p.weekday] ?? 1,
    weekdayCN: p.weekdayCN,
    dayNum: dayNumOf(Number(p.year), Number(p.month), Number(p.day)),
  };
}

/**
 * 某天的整日窗口 [00:00, 23:59]。
 *
 * 带 `dayNum` 出去是给「钟点合并」用的：`3am on a Tuesday` 里星期与钟点
 * 是**同一个时间表达的两半**，必须先知道锁定的是哪一天，才能把 3am 钉上去。
 * 把日期留在窗口对象里，比事后再去反解 ISO 字符串可靠。
 */
function fullDay(dayNum, zone) {
  return { from: at(dayNum, 0, 0, zone), to: at(dayNum, 23, 59, zone), precision: 'day', dayNum };
}

/** 某天某钟点的那一小时 [hh:00, hh:59]。精度与「in 2 hours」同档，都是能指到点上的表达。 */
function atClock(dayNum, hh, mm, zone) {
  const from = at(dayNum, hh, mm, zone);
  return { from, to: from + 59 * 60_000, precision: 'instant', dayNum };
}

/* ------------------------------- 词表 ------------------------------- */

// 明确的额度事件词。命中 reset / 额度词才可能构成 explicit。
const RE_RESET = /\breset(?:s|ting)?\b|\bresetting\b|\bresets\b/i;
const RE_SCOPE = /\b(limits?|usage|allowance|allowances|quota|quotas|rate limits?|credits?|banked|token budget)\b/i;
const RE_GENEROUS = /\b(fresh|new|another|top(?:ped)?[ -]?up|refill|replenish|more|extra|unlimited|bank(?:ed|s)?)\b/i;
// 未来语气
const RE_FUTURE = /\b(will|we'll|i'll|gonna|going to|plan to|planning to|will be|soon|next|later|tomorrow|in \d+)\b/i;
// 已完成的过去式
const RE_PAST = /\breset\s+(?:all\s+)?(?:propagated|complete[ds]?|done|rolled|finished|is\s+live|live|deployed|landed)\b|\b(?:has|have|had|is|are|was|were|been)\s+(?:now\s+)?(?:been\s+)?reset\b|\breset\s+has\b/i;
// 与额度无关的发布/宣传语境
const RE_LAUNCH = /\b(launch(?:ing|ed)?|keynote|ship(?:ping|ped)?|releas(?:e|ing|ed)|announc(?:e|ing|ed|ement)|blog|demo|podcast|feature|model|styleguide|api|mcp|codex app|chatgpt app|super ?app)\b/i;

/**
 * 「延续／确认」语气 —— 他回应额度话题时说「它还是会来」。
 *
 * 这是**借用上下文**的唯一闸门，必须严格：没有它，只要被回复的推文里出现过
 * reset，他任何一句带时间的回复都会被判成预告（「will look into it tomorrow」
 * 里的 will 就是个反例，所以这里要求 will 后面必须跟「到来」类动词）。
 */
const RE_CONTINUE =
  /\b(?:still\s+(?:coming|on\s+track|happening|landing|arriving)|(?:it'?s|it\s+is|its)\s+(?:still\s+)?coming|coming\s+(?:in|on|this|next|later|tomorrow|soon)|will\s+(?:still\s+)?(?:come|land|happen|arrive|be\s+reset|reset)|on\s+track|right\s+around\s+the\s+corner|very\s+soon)\b/i;

/* ------------------- 「已发生」判定的补充词表 ------------------- */

const RE_CREDIT = /\b(banked|credit|credits)\b/i;

/**
 * 「A reset」这类**名词化陈述** —— 冠词直接修饰 reset。
 *
 * 为什么必须单列一条：「Reset all propagated」当初是靠额度词表里的 `all` 命中
 * 才被当成重置的 —— 那纯属巧合（那个 all 是「全部传播完毕」，跟额度毫无关系）。
 * 而同一天更早、更该被看见的
 *   「Hi Astra users. A reset and a quick update on quality issues…」
 * 没写 all，就被判成普通内容。观测台最重要的两条数据，一条靠巧合、一条直接丢。
 *
 * 名词化（冠词 + reset）表达的是「存在一次重置」这个事实，比动词形态更接近宣布。
 */
const RE_ANNOUNCE =
  /\b(?:a|an|the|another|one|this|that)\s+(?:full\s+|fresh\s+|banked\s+|surprise\s+|bonus\s+)?reset\b/i;

/** 假设 / 条件 / 否定语境 —— 命中时「名词化的 reset」不能当既成事实。 */
const RE_HYPOTHETICAL = /\b(?:if|unless|whether|would|could|might|should|suppose|imagine|unless)\b|\bwon'?t\s+reset\b/i;

/** 将来完成时：「will have reset … by tomorrow」不是已完成。 */
const RE_FUTURE_PERFECT = /\b(?:will|shall|going\s+to|gonna)\s+(?:have|be)\b/i;

/**
 * 一条推文是否在陈述「额度重置**已经发生**」。
 *
 * 与「预告下一次重置」是两回事：
 *   「Reset all propagated. Sweet dreams.」          → 已完成，陈述事实
 *   「Hi Astra users. A reset and a quick update…」  → 宣布刚刚发生
 *   「we will reset everyone's limits next Tuesday」 → 预告，尚未发生
 *
 * 为什么必须分级而不是一律当预告：旧实现把「重置已完成」当垃圾丢掉
 * （`isPast` → level:none），于是页面自相矛盾 —— 「最近记录」里那条明明标着
 * 「普通重置」，信号区却说「没有检测到重置预告」。而观测台要回答的第一个问题
 * 就是「上次重置是什么时候」，把已发生的事实丢掉，等于不回答自己的主问题。
 */
export function hasOccurredReset(text) {
  const t = String(text ?? '');
  if (!RE_RESET.test(t)) return false;
  if (RE_HYPOTHETICAL.test(t)) return false;
  if (RE_FUTURE_PERFECT.test(t)) return false;
  // 完成句式（reset all propagated / has been reset / reset is live）是强证据：
  // 即使同一句里还夹着别的未来语气，这条重置也已经发生了。
  if (RE_PAST.test(t)) return true;
  // 名词化是弱证据，只在这条没有未来语气时才作数。
  if (RE_FUTURE.test(t)) return false;
  return RE_ANNOUNCE.test(t);
}

/**
 * 归类一条推文是否属于「额度事件」，并给出类型。
 *
 * 与 collect.mjs 里旧的 classify 的差别：旧版要求 reset 必须**同时**命中额度词，
 * 而它的额度词表里含 `all` —— 于是 "Reset all propagated" 靠这个 all 蒙到 reset，
 * 同一天的 "A reset and …" 没写 all 就掉成 other。
 *
 * 判据放在这里而不是采集侧，是为了让「采集时打的 kind」与「识别时给的 level」
 * 出自同一份词表。它们曾经是两份，结论互相打架。
 */
export function classifyEvent(text) {
  const t = String(text ?? '');
  if (!RE_RESET.test(t)) return RE_CREDIT.test(t) ? 'credit' : 'other';
  if (RE_CREDIT.test(t)) return 'credit'; // 发券型重置
  if (hasOccurredReset(t) || RE_SCOPE.test(t)) return 'reset';
  return 'other';
}

/* --------------------------- 时间表达解析 --------------------------- */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
const WEEKDAY_RE =
  'mon(?:day)?|tue(?:s|sday)?|wed(?:nesday|s)?|thu(?:rs?|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';
const WEEKDAY_MAP = {
  mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7,
};

/**
 * 时间表达的「具体程度」权重。
 *
 * 为什么需要它：一条推文里可能同时出现多个时间表达，例如
 *   「Good news: we will reset everyone's usage limits next Tuesday. Enjoy the weekend.」
 * 这里的 `weekend` 只是寒暄。若按「窗口开始得早」选第一个，weekend（本月 19 日）
 * 会压过真正的 `next Tuesday`（22 日），把一条未来预告显示成已经过去的窗口 —— 见 KI-001。
 *
 * 所以选取顺序是：**具体程度优先 → 原文位置靠前优先 → 时间靠前优先**。
 */
const SPEC = {
  clockInDay: 96, // 3am on a Tuesday —— 「某天某钟点」，最具体
  absoluteDate: 100, // 2026-10-03 / Oct 3 —— 无歧义
  weekdayModified: 92, // next Tuesday / this Tuesday —— 有修饰词，指向确定的那一天
  relativeHours: 88, // in 2 hours —— 精确到小时
  weekdayBare: 86, // Tuesday
  tomorrow: 86,
  tonight: 72,
  today: 72, // today / later today / this afternoon
  relativeDays: 62, // in 2 days / in a few weeks —— 有量词但仍是大颗粒
  weekPart: 55, // early next week / end of next week
  week: 40, // next week / this week
  weekend: 28, // weekend —— 最含糊
};

/** 视为「含糊表达」的阈值：只有在没有更具体表达时才可作候选，且窗口剩余时间要过半 */
const VAGUE_SPEC = 50;

/**
 * 从文本里抽出所有时间表达，解析成时间窗口。可能得到多个（按 SPEC 选主解读）。
 *
 * ⚠ 英文相对时间词本身有歧义。这里的处理是：
 *   - 主解读 = 规则化解读（"next Tuesday" 取「下一个自然周的周二」）
 *   - 同时给出另一种常见解读，标注为 alt，让用户自己判断
 *   不掩盖歧义，也不假装只有一个正确答案。
 */
function parseTimes(text, refTs, zone) {
  const t = text.toLowerCase();
  const lp = localParts(refTs, zone);
  const out = [];

  const push = (w, word, note, spec) => {
    if (!w || !Number.isFinite(w.from)) return;
    const idx = t.indexOf(String(word).toLowerCase());
    out.push({
      ...w,
      word,
      note: note ?? null,
      spec: spec ?? SPEC.weekend,
      // 位置用于「具体程度打平」时定序：靠前的更可能是句子主体
      idx: idx < 0 ? Number.MAX_SAFE_INTEGER : idx,
    });
  };

  // 1) 具体日期 2026-10-03
  const iso = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const dn = dayNumOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    push(fullDay(dn, zone), iso[0], null, SPEC.absoluteDate);
  }

  // 2) 月 + 日：Oct 3 / October 3rd / 3 October
  const md =
    t.match(new RegExp(`\\b(${MONTH_RE})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`)) ??
    t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})[a-z]*\\b`));
  if (md) {
    const monthFirst = Number.isNaN(Number(md[1]));
    const monName = monthFirst ? md[1] : md[2];
    const mo = MONTHS[monName.slice(0, 4)] ?? MONTHS[monName.slice(0, 3)];
    const dd = Number(monthFirst ? md[2] : md[1]);
    if (mo && dd >= 1 && dd <= 31) {
      let y = lp.y;
      // 已过去的日期按「下一次」理解
      if (dayNumOf(y, mo, dd) < lp.dayNum) y += 1;
      push(fullDay(dayNumOf(y, mo, dd), zone), md[0].trim(), null, SPEC.absoluteDate);
    }
  }

  // 3) 星期：next Tuesday / this Tuesday / Tuesday / coming Tuesday / coming in Tuesday
  //    最后一个形式（"coming in Tuesday"）是实测里真实出现过的口语写法，
  //    中间多了个 in —— 修饰词与星期之间要允许它，否则会退化成「裸 Tuesday」解读。
  const wd = t.match(
    new RegExp(`\\b(?:(next|this|coming|upcoming)\\s+(?:in\\s+)?)?(${WEEKDAY_RE})\\b`)
  );
  if (wd) {
    const target = WEEKDAY_MAP[wd[2]];
    if (target) {
      const mondayIdx = lp.dayNum - (lp.iso - 1); // 本周一
      const daysAhead = (((target - lp.iso) % 7) + 7) % 7;
      const bare = lp.dayNum + daysAhead; // 「本周内最近的那个」
      const nextWeek = mondayIdx + 7 + (target - 1); // 「下一个自然周的同一个星期几」
      const mode = wd[1];
      const primary = mode === 'next' ? nextWeek : bare;
      const altDay = mode === 'next' ? bare : null;
      const w = fullDay(primary, zone);
      w.refDay = primary;
      push(
        w,
        wd[0].trim(),
        altDay !== null && Math.abs(altDay - primary) > 0
          ? `另一种解读：${ymdLabel(altDay)}（把 “next ${wd[2]}” 理解为最近的${weekdayCNof(altDay)}）`
          : null,
        // ⚠ 这里必须显式传 spec。漏传会落到 push 的默认值 SPEC.weekend(28)，
        //   即把「一个确定的日期」当成「最含糊的表达」—— 后果不只是排序错：
        //   future 过滤对 spec ≤ VAGUE_SPEC 的表达要求「窗口过半还没过」，
        //   于是**当天下午说「reset on Tuesday」会因为当天窗口已过半而被整条丢掉**。
        //   他大量时间线索就是这么给的（裸星期 + 钟点），漏传等于持续静默漏数据。
        mode ? SPEC.weekdayModified : SPEC.weekdayBare
      );
    }
  }

  // 4) 今天 / 明天 / 今晚 / 稍后
  if (/\btomorrow\b/.test(t)) push(fullDay(lp.dayNum + 1, zone), 'tomorrow', null, SPEC.tomorrow);
  if (/\btonight\b/.test(t)) {
    const { y, m, d } = ymdOf(lp.dayNum);
    push(
      {
        from: zonedToTs(y, m, d, 18, 0, zone),
        to: zonedToTs(y, m, d, 23, 59, zone),
        precision: 'evening',
        dayNum: lp.dayNum,
      },
      'tonight',
      null,
      SPEC.tonight
    );
  }
  if (/\b(today|later today|this afternoon|this morning)\b/.test(t)) {
    const kind = t.match(/\b(later today|this afternoon|this morning)\b/)?.[0];
    const { y, m, d } = ymdOf(lp.dayNum);
    const from =
      kind === 'this morning' ? zonedToTs(y, m, d, 6, 0, zone)
      : kind === 'this afternoon' ? zonedToTs(y, m, d, 12, 0, zone)
      : kind === 'later today' ? refTs
      : zonedToTs(y, m, d, 0, 0, zone);
    push(
      { from, to: zonedToTs(y, m, d, 23, 59, zone), precision: 'day', dayNum: lp.dayNum },
      kind ?? 'today',
      null,
      SPEC.today
    );
  }

  // 5) in N hours/days/weeks
  const rel = t.match(
    /\bin\s+(a few|a couple of|couple of|several|\d+)\s+(minutes?|hours?|days?|weeks?|months?)\b/
  );
  if (rel) {
    const qty =
      rel[1] === 'a few' || rel[1] === 'several' ? 3
      : rel[1] === 'a couple of' || rel[1] === 'couple of' ? 2
      : Number(rel[1]);
    const unitMs =
      /minute/.test(rel[2]) ? 60_000
      : /hour/.test(rel[2]) ? HOUR
      : /day/.test(rel[2]) ? DAY
      : /week/.test(rel[2]) ? 7 * DAY
      : 30 * DAY;
    const at = refTs + qty * unitMs;
    push(
      { from: at, to: at + Math.min(unitMs, DAY) - 60_000, precision: 'instant' },
      rel[0]
    );
  }

  // 6) 周维度：next week / this week / early next week / end of next week / this weekend
  const mondayIdx = lp.dayNum - (lp.iso - 1);
  const weekLabel = (offsetDays) => {
    const { y, m, d } = ymdOf(offsetDays);
    return `${m}.${d}`;
  };
  if (/\b(early|beginning of|start of)\s+(next\s+)?week\b/.test(t)) {
    const base = /next\s+week/.test(t) ? mondayIdx + 7 : mondayIdx;
    push(
      {
        from: at(base, 0, 0, zone),
        to: at(base + 2, 23, 59, zone),
        precision: 'week-part',
      },
      t.match(/\b(early|beginning of|start of)\s+(next\s+)?week\b/)[0],
      null,
      SPEC.weekPart
    );
  } else if (/\b(end of|late)\s+(next\s+)?week\b/.test(t)) {
    const base = /next\s+week/.test(t) ? mondayIdx + 7 : mondayIdx;
    push(
      {
        from: at(base + 3, 0, 0, zone),
        to: at(base + 6, 23, 59, zone),
        precision: 'week-part',
      },
      t.match(/\b(end of|late)\s+(next\s+)?week\b/)[0],
      null,
      SPEC.weekPart
    );
  } else if (/\bnext\s+week\b/.test(t)) {
    push(
      {
        from: at(mondayIdx + 7, 0, 0, zone),
        to: at(mondayIdx + 13, 23, 59, zone),
        precision: 'week',
      },
      'next week',
      null,
      SPEC.week
    );
  } else if (/\bthis\s+week\b/.test(t)) {
    push(
      {
        from: refTs,
        to: at(mondayIdx + 6, 23, 59, zone),
        precision: 'week',
      },
      'this week',
      null,
      SPEC.week
    );
  }
  if (/\b(this\s+)?weekend\b/.test(t)) {
    const sat = mondayIdx + 5;
    push(
      {
        from: at(sat, 0, 0, zone),
        to: at(sat + 1, 23, 59, zone),
        precision: 'week-part',
      },
      'weekend',
      null,
      SPEC.weekend
    );
  }

  /* 7) 钟点：3am / 11pm / 3:30pm / midnight / noon
   *
   * 这一档此前**完全缺失** —— 解析器最深只能走到「星期 → 全天」，所以
   * 「11pm on a Tuesday」「3am on a tuesday」里的钟点被整段忽略，精度永远停在 `day`。
   * 他恰恰习惯用「星期 + 钟点」这种写法埋时间（见 docs/data-source.md 的实测清单）。
   *
   * 两个要点：
   *   ① 钟点与同句的日期是**同一个表达的两半**（"3am on a Tuesday"），必须合并，
   *      且以钟点为准。否则会同时产出「周二全天」和「某一个 3am」两个窗口，
   *      而且按 spec 排序会让那个**没有日期约束**的 3am 抢先 —— 那是错的。
   *   ② 句中没有日期时，钟点才以「最近的未来那一刻」自行定日 ——
   *      对应他单独说「we'll reset at 3am」这种情形。
   */
  const clocks = [];
  const clockRe = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/g;
  let cm;
  while ((cm = clockRe.exec(t)) !== null) {
    let hh = Number(cm[1]);
    const mm = Number(cm[2] ?? 0);
    if (hh < 1 || hh > 12 || mm > 59) continue;
    if (cm[3] === 'pm' && hh !== 12) hh += 12;
    if (cm[3] === 'am' && hh === 12) hh = 0;
    clocks.push({ hh, mm, word: cm[0].replace(/\s+/g, ' ').trim() });
  }
  // midnight / noon 是钟点的命名形式。只在没有数字钟点时兜底，
  // 免得 "midnight" 与 "12am" 同时出现时产出两个一模一样的窗口。
  if (!clocks.length) {
    if (/\bmidnight\b/.test(t)) clocks.push({ hh: 0, mm: 0, word: 'midnight' });
    else if (/\bnoon\b/.test(t)) clocks.push({ hh: 12, mm: 0, word: 'noon' });
  }

  if (clocks.length) {
    // 挑句中最具体的**日期型**窗口作为锚点。week / weekend 这类是范围而不是某一天，
    // 没有 dayNum，本来就不该当锚点（把 3am 钉到「下周」上是没有意义的）。
    const dated = out
      .filter((w) => Number.isFinite(w.dayNum))
      .sort((a, b) => b.spec - a.spec)[0];
    for (const c of clocks) {
      if (dated) {
        push(atClock(dated.dayNum, c.hh, c.mm, zone), c.word, null, SPEC.clockInDay);
      } else {
        let dn = lp.dayNum;
        if (at(dn, c.hh, c.mm, zone) < refTs) dn += 1;
        push(atClock(dn, c.hh, c.mm, zone), c.word, null, SPEC.clockInDay);
      }
    }
  }

  const seen = new Set();
  return out.filter((w) => {
    const key = `${w.word}|${w.from}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ymdLabel(dayNum) {
  const { y, m, d } = ymdOf(dayNum);
  return `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}（${weekdayCNof(dayNum)}）`;
}

function weekdayCNof(dayNum) {
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  // dayNum=0 对应 1970-01-01，是周四
  const idx = (((dayNum + 3) % 7) + 7) % 7;
  return names[idx];
}

/* ------------------------------- 窗口表述 ------------------------------- */

const fmt = (isoStr, zone) => partsIn(isoStr, zone);

/**
 * 窗口的文案表述。
 *
 * ── 一条规矩：**具体时刻优先，区间只在时间本来就含糊时出现** ──────────
 * 老大原话：「tibo 当地时间为什么还不是具体的时间，北京时间也只需填具体时间，
 * 只有时间不明确的时候才是时间段。」
 *
 * 改之前的两行是这么写的（实测 2026-09-22 那一次）：
 *   Tibo 当地时间   2026.09.22（周二）00:00 – 23:59
 *   北京时间       2026.09.22（周二）15:00 → 2026.09.23（周三）14:59
 *
 * 两行都不对，而且是两种不同的不对：
 *   ① 「00:00 – 23:59」把「周二」这个**天粒度**硬展开成钟点区间，读起来像
 *      「他定在当地午夜重置」—— 可他一个钟点都没说过。**这是凭空长出来的精度。**
 *   ② 北京那行的 `15:00 → 次日 14:59` 是把 ① 又换算了一遍，于是页面上唯一的
 *      「具体时间」被夹在一个跨自然日的箭头里，看不出哪一刻是**窗口开启**。
 *
 * 现在按粒度分三种走：
 *   - `instant`（真说了钟点）→ 两边各给**一个时刻**；
 *   - 当地一整天（`day` 粒度）→ 当地写「哪天 + 全天」，北京只给**开启那一刻**，
 *     区间降级成 `rangeNote` 里的一句说明；
 *   - 整周 / 一周内的某几天 → 时间**本来就含糊**，区间才是诚实的表达，照给区间。
 */
function describeWindow(w, sourceZone, userZone) {
  const f = fmt(new Date(w.from).toISOString(), userZone);
  const t2 = fmt(new Date(w.to).toISOString(), userZone);
  const sf = fmt(new Date(w.from).toISOString(), sourceZone);
  const st = fmt(new Date(w.to).toISOString(), sourceZone);

  const sameUserDay = f.year === t2.year && f.month === t2.month && f.day === t2.day;
  const sameSourceDay = sf.year === st.year && sf.month === st.month && sf.day === st.day;

  const datetime = (p) => `${p.year}.${p.month}.${p.day}（${p.weekdayCN}）${p.hour}:${p.minute}`;
  const dayOnly = (p) => `${p.year}.${p.month}.${p.day}（${p.weekdayCN}）`;

  // 「当地一整天」：起止落在同一天、起 00:00 止 23:59。只有 day 粒度会长这样，
  // 所以它等价于「他说了是哪一天，但没说钟点」。
  const wholeLocalDay =
    sameSourceDay && sf.hour === '00' && sf.minute === '00' && st.hour === '23' && st.minute === '59';
  const instant = w.precision === 'instant';

  let sourceText;
  let userText;
  let rangeNote = '';

  if (instant) {
    sourceText = datetime(sf);
    userText = datetime(f);
  } else if (wholeLocalDay) {
    // 「全天」前留一个空格：窄屏的窗口值独占一行、宽度刚好卡在临界点上，
    // 不留这个空格浏览器会在「全 / 天」之间断行（实测小程序端 15px 字号）。
    // 断在词中间比多一个空格难看得多。
    sourceText = `${dayOnly(sf)} 全天`;
    // 「起」不能省：省掉之后「09.22 15:00」会被读成「他定在 15:00 重置」，
    // 而 15:00 只是这个当地日的左端点。差别就是一句话的真假。
    userText = `${datetime(f)} 起`;
    rangeNote = `窗口到北京 ${datetime(t2)} 为止`;
  } else {
    sourceText = sameSourceDay
      ? `${dayOnly(sf)}${sf.hour}:${sf.minute} – ${st.hour}:${st.minute}`
      : `${datetime(sf)} → ${datetime(st)}`;
    userText = sameUserDay
      ? `${dayOnly(f)}${f.hour}:${f.minute} – ${t2.hour}:${t2.minute}`
      : `${datetime(f)} → ${datetime(t2)}`;
  }

  return {
    // 时间戳以**数字**形式再带一份：window.from 是 ISO 字符串，而小程序端
    // 解析 ISO 在个别机型上有兼容差异（format.js 顶部刻意绕开 Intl 也是同一考虑）。
    // 倒计时每秒都在跑，这里不给它留解析歧义的余地。
    fromTs: w.from,
    toTs: w.to,
    // 起始日的结构化日期（北京时间视角），供大字公告直接拼装
    userFrom: { y: f.year, m: f.month, d: f.day, hh: f.hour, mm: f.minute, weekdayCN: f.weekdayCN },
    sourceZone: sourceText,
    userZone: userText,
    // 窗口开启那一刻（北京时间视角，单点）。倒计时的锚点要写在标签里 ——
    // 页面上只给一个跳动的数字、不说它数到哪一刻，读的人没法核对，
    // 这正是「你这时间也不对啊」那一条反馈的来源。
    openText: datetime(f),
    // 区间说明。只在对窗口做了「收敛成单点」的粒度下才有内容，
    // 让读者知道还有一段范围，但不把它摆在主位上。
    rangeNote,
    crossesUserDay: !sameUserDay,
    zones: dualZone(new Date(w.from).toISOString(), userZone, sourceZone, '北京时间', 'Tibo 当地时间'),
  };
}

/* ------------------------------- 单条分析 ------------------------------- */

/**
 * 分析一条推文。
 * @param {{text:string, created_at:string, id?:string, account?:string}} tweet
 */
export function analyzeTweet(tweet, opts = {}) {
  const sourceZone = opts.sourceZone ?? SOURCE_ZONE;
  const userZone = opts.userZone ?? USER_ZONE;
  const text = String(tweet.text ?? '').replace(/\s+/g, ' ').trim();
  const refTs = new Date(tweet.created_at ?? Date.now()).getTime();
  const reasons = [];

  const hasReset = RE_RESET.test(text);
  const hasScope = RE_SCOPE.test(text);
  const hasGenerous = RE_GENEROUS.test(text);
  const hasFuture = RE_FUTURE.test(text);
  const isPast = RE_PAST.test(text);
  const isLaunch = RE_LAUNCH.test(text);
  // 「已发生」的**形态**判据（纯文本，只看句子长得像不像）。真正的结论在
  // 时间解析之后 —— 还要看句中有没有具体的未来时间，见下文 `occurred`。
  const occurredShape = hasOccurredReset(text);

  const ownIntent = (hasReset ? 3 : 0) + (hasScope ? 2 : 0) + (hasGenerous ? 1 : 0);
  const hasAnnounce = RE_ANNOUNCE.test(text);
  if (hasReset) reasons.push('命中重置词 reset');
  if (hasScope) reasons.push('命中额度词 limits/usage/credits');
  if (hasGenerous) reasons.push('命中「新额度」类词 fresh/new/top up');
  if (hasFuture) reasons.push('含未来语气');
  // 「判定依据」要写**命中了什么**，不写它对分数做了什么。
  // 早先这里写的是「判定为已完成的过去事件（扣分）」—— 那时它确实是排除理由；
  // 现在它反过来是 occurred 的核心判据，再写「扣分」就与结论自相矛盾了。
  if (isPast) reasons.push('命中「重置已完成」句式（reset all propagated 等）');
  if (hasAnnounce) reasons.push('命中「A/the reset」名词化陈述');
  // 发布语境只对「预告」构成干扰（「下周发新模型」里的 will/next 会被误读成重置预告），
  // 对「已发生」没有影响 —— 一条已确认的重置不会因为同句提到 model 就不算数。
  if (isLaunch && !occurredShape) reasons.push('含发布/宣传语境（下调置信度）');

  /* ── 上下文（他回复的那条推文）─────────────────────────────────────────
   *
   * 他在回复里做预告时，经常一个额度词都不带：
   *   「OK fine. But it's also still coming in Tuesday」
   * 单独看这条，任何词表都读不出「这是在说重置」—— 额度语境在被回复的那条
   * 推文里（有人在催 "you owe us a banked reset"）。
   *
   * 所以：本条无额度词、但上下文有额度语境、**且本条带「延续/确认」语气**时，
   * 借上下文的意图来判。三道闸门缺一不可 —— 尤其是延续语气那道，
   * 没有它，只要被回复的推文里出现过 reset，他任何一句带时间的回复都会被误判。
   *
   * 注意：时间表达**只从本条取**，不碰上下文。上下文里的 "this week" 是
   * 提问者自己的时间坐标，不是他的承诺时点。
   */
  const ctx = tweet.inReplyTo ?? null;
  const ctxText = String(ctx?.text ?? '').replace(/\s+/g, ' ').trim();
  // 上下文必须是**额度**重置语境，而不是随便一个 reset 词。
  //   「you owe us a banked reset」                    → reset + 额度词 ✅ 借
  //   「the model weights reset made training faster」 → 只有 reset，与额度无关 ✗ 不借
  // 光看有没有 reset 是不够的 —— 上面第二条也会让它成立，然后他任何一句带时间的
  // 回复都会被误判成预告。所以要求 reset 必须与额度词同时出现。
  const ctxIntent =
    ctxText && RE_RESET.test(ctxText) && RE_SCOPE.test(ctxText)
      ? 3 + (RE_GENEROUS.test(ctxText) ? 1 : 0)
      : 0;
  const hasContinue = RE_CONTINUE.test(text);
  const viaContext = ownIntent < 2 && ctxIntent >= 2 && hasContinue;
  const intent = viaContext ? Math.max(ownIntent, 3) : ownIntent;

  if (ctxText) {
    reasons.push(`上下文：回复 @${ctx?.account ?? '?'}「${ctxText.slice(0, 36)}…」`);
    if (viaContext) {
      reasons.push('本条不含额度词，额度语境借自上下文 + 延续语气 → 判为预告');
    } else if (hasContinue && ownIntent < 2) {
      reasons.push('含延续语气，但被回复的推文无额度语境，不借意图');
    } else if (ctxIntent >= 2) {
      reasons.push('被回复的推文含额度语境（本条无延续语气，不借意图）');
    }
  }

  const times = parseTimes(text, refTs, sourceZone);
  // 只保留指向未来的窗口。「未来」的判定分两档：
  //   · 具体表达（下周二 / 明天 / in 2 hours）只要还没结束就算 —— 即使已经过了半天，
  //     它仍然指向未来的那一天，不该丢；
  //   · 含糊表达（this week / weekend）要求**窗口还剩一半以上**，否则说的很可能是
  //     已经过去的那一周/那个周末。放宽到「end 晚于现在」会让寒暄里的 "Enjoy the weekend"
  //     在周日傍晚仍然算作未来窗口（KI-001）。
  const future = times.filter((w) => {
    if (w.to < refTs) return false;
    if (w.spec <= VAGUE_SPEC) return (w.from + w.to) / 2 >= refTs;
    return true;
  });
  // 选取顺序：具体程度优先 → 原文位置靠前优先 → 时间靠前优先。
  // 不能只按时间先后 —— 那会让「更早但更含糊」的表达压过句子的真正主体（KI-001）。
  const timeOpts = [...future].sort(
    (a, b) => b.spec - a.spec || a.idx - b.idx || a.from - b.from
  );

  /* 「A reset」这类名词化陈述只有在**看不出是未来**时才算「已发生」。
   *
   * 反例（写这一版时的实测教训）：
   *   「I promised a reset for Tuesday」  → 形态上完全符合名词化陈述，
   *                                        但它是**承诺**，句中给了具体的未来日
   *   「Reset all propagated」            → 没有未来时间 → 确属已发生
   *
   * 不加这道闸门，任何写「a reset」的承诺都会被判成「刚重置过」——
   * 而「a reset」恰恰是他最常用的句式之一（实测语料里 09-12 与 09-22 各一条）。
   * 早先这一版之所以没暴露，是因为真实那句话里恰好有 "See you soon"，
   * 命中了 RE_FUTURE 才侥幸走了预告分支 —— 靠巧合成立，不是判据成立。
   *
   * 判据用「具体程度 > VAGUE_SPEC」而不是「有没有时间词」：含糊的 this week
   * 不足以推翻一条明确的已完成陈述，只有具体到日/时的未来表达才可以。
   */
  const occurred = occurredShape && !future.some((w) => w.spec > VAGUE_SPEC);

  const createdZones = dualZone(
    new Date(refTs).toISOString(),
    userZone,
    sourceZone,
    '北京时间',
    'Tibo 当地时间'
  );

  const base = {
    id: tweet.id ?? null,
    account: tweet.account ?? opts.account ?? 'thsottiaux',
    text,
    createdAt: new Date(refTs).toISOString(),
    url: tweet.id ? `https://x.com/${tweet.account ?? opts.account ?? 'thsottiaux'}/status/${tweet.id}` : null,
    reasons,
    // 是否靠上下文推断出来的。页面对这两类可以显示不同徽标 ——
    // 直接命中是「他自己说 reset」，上下文推断是「他在回应额度话题并承诺时间」，
    // 后者的可信度同样高，但依据不同，不该混为一谈。
    viaContext,
    inReplyTo: ctxText
      ? { account: ctx?.account ?? null, id: ctx?.id ?? null, text: ctxText }
      : null,
    // 发布时刻的双时区表述在这里算好跟着数据走。
    // 原因：小程序端要算这个得依赖 Intl，而部分安卓机型上 Intl 不可用/不完整。
    // 时区换算属于「算法」而不是「渲染」，放在这一层算一次，两端共用同一份结果。
    createdZones: { a: createdZones.a, b: createdZones.b, diffText: createdZones.diffText },
  };

  /* 判定顺序很重要：**先判「已发生」，再谈预告**。
   *
   * 已发生的重置是既成事实，比预告更硬；而且它正是观测台的主问题
   * （上次重置是什么时候）。旧实现把这类推文判成 level:'none'
   * （理由写的是「已完成的过去事件，不是预告」）—— 于是采集侧 classify
   * 把它标成 kind:'reset'、识别侧说它「不是信号」，同一份数据两个结论，
   * 页面「最近记录」显示「普通重置」，信号区却说「没有检测到重置预告」。
   */
  if (occurred) {
    return {
      ...base,
      level: 'occurred',
      rejected: null,
      intent,
      // 发生时刻就是它自己的发布时刻，base.createdZones 已经算好双时区表述，
      // 不必再造一个「窗口」—— 窗口的语义是「未来某段区间」，会误导。
      occurredAt: new Date(refTs).toISOString(),
      window: null,
      confidence: Math.max(0.3, Math.min(0.95, 0.5 + intent * 0.06 + (isPast ? 0.12 : 0))),
    };
  }

  // 未来预告必须有额度意图。只有时间词没有意图 → 只作线索（避免把「发布延期」当重置信号）
  if (intent < 2) {
    const cand = timeOpts[0] ?? null;
    return {
      ...base,
      level: timeOpts.length ? 'hint' : 'none',
      rejected: timeOpts.length
        ? `含时间表达「${timeOpts[0].word}」但没有额度相关词，不作为重置信号`
        : '无额度相关词',
      intent,
      window: null,
      // 时间线索**不丢弃**，只是不当作信号呈现。
      //
      // 这一条是「综合分析」的原料：单看「3am on a tuesday」确实不是承诺
      // （他在说别人的活动），但如果同一天有好几条推文各自指向同一个日期，
      // 那些指向本身就是证据。旧实现到这里直接 `window: null`，等于把
      // 「系统看到了什么时间」这件事抹掉 —— 事后既无法复核，也无法聚合。
      candidateWindow: cand
        ? {
            word: cand.word,
            precision: cand.precision,
            from: new Date(cand.from).toISOString(),
            to: new Date(cand.to).toISOString(),
            dayNum: Number.isFinite(cand.dayNum) ? cand.dayNum : null,
            spec: cand.spec,
            // 歧义提示要跟着线索走。裸星期（"a Tuesday"）天然有两种解读，
            // 周三说「11pm on a Tuesday」既可能指刚过去的周二、也可能指下一个。
            // 把线索拿去聚合时，这个 note 决定了它该被当**确定证据**还是**待考证据**。
            note: cand.note ?? null,
          }
        : null,
    };
  }

  if (!timeOpts.length) {
    return {
      ...base,
      level: 'hint',
      rejected: '有额度意图但没给出时间，只能作线索',
      intent,
      window: null,
      candidateWindow: null,
    };
  }

  const w = timeOpts[0];
  // 升到 explicit 的条件：额度意图足够强（单独一个 reset 词算 3 分，
  // 或「额度词 + 新额度词」合起来算 3 分）。只有额度词没有「新给」的含义时，
  // 仍降级为线索 —— 否则「我们在调 usage limits」这种无关推文会被误报。
  const level = intent >= 3 ? 'explicit' : 'hint';
  const win = describeWindow(w, sourceZone, userZone);

  return {
    ...base,
    level,
    rejected: null,
    intent,
    timeWord: w.word,
    timeNote: w.note,
    precision: w.precision,
    candidateWindow: null,
    window: {
      from: new Date(w.from).toISOString(),
      to: new Date(w.to).toISOString(),
      // 锚定的当地日历日。跨推文聚合靠它对齐 —— 比反解 ISO 字符串可靠。
      dayNum: Number.isFinite(w.dayNum) ? w.dayNum : null,
      ...win,
    },
    confidence:
      Math.max(0.2, Math.min(0.95, 0.35 + intent * 0.08 + (hasReset ? 0.1 : 0))) -
      (isLaunch ? 0.15 : 0) -
      // 借上下文推断的，依据链多一环，置信度相应扣一点
      (viaContext ? 0.08 : 0),
  };
}

/* --------------------------- 跨推文证据聚合 --------------------------- */

/**
 * 精度的具体程度排序。用于「同一天的多条承诺里，取最精确的那条定窗口」。
 * 它是 SPEC 的时间维度版本 —— SPEC 排的是**表达**的具体程度，
 * 这里排的是**已解析出的精度**，用途不同，所以单独一份。
 */
const PRECISION_RANK = { instant: 5, evening: 4, day: 3, 'week-part': 2, week: 1 };

/**
 * 把「同一天」的所有时间线索聚成一条假设 —— 这就是「综合分析」。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────
 * 老大反问：「他不是都有 3am on a tuesday 这样的回复了吗，为什么没有明确时间？」
 * 查下来是三件事同时成立：
 *   ① 那些钟点**确实都被解析出来了**（"3am on a tuesday" → 当地 09-22 周二），
 *      但单条看没有额度语境，`window` 被置空、线索随之消失；
 *   ② 解析器此前**没有钟点维度**，即使有额度语境也只能给到「全天」；
 *   ③ 系统**从来不看推文之间**的关系 —— 逐条判完就结束。
 *
 * 这一层补的是 ③：把指向同一日历日的推文收在一处，并**分明证据强度**。
 * 单条看「他在说别人的活动」的推文，和「他承诺了这一天」的推文并置时，
 * 前者的价值才显出来 —— 它证明这个日子在他嘴里反复出现。
 *
 * ── 但强度必须分明，不能一锅端 ──────────────────────────────────────
 *   hard（有额度承诺）→ 决定窗口。这是「他确实答应了」。
 *   soft（只有时间、无额度语境）→ **只作旁证，不改窗口**。
 * 把 soft 也算进窗口就等于：他随口提到某个周二，页面就报一个重置时间。
 * 那正是这个产品最不能出的错 —— 假信号比漏检更伤可信度。
 *
 * @param {Array} analyzed analyzeTweet 的产出（已按时间倒序）
 * @returns {object|null} 没有明确承诺时返回 null
 */
export function buildHypothesis(analyzed, opts = {}) {
  const list = analyzed ?? [];
  const hard = list.filter((a) => a.level === 'explicit' && a.window);
  if (!hard.length) return null;

  // 锚定日：取同日硬证据中**最精确**的那条的窗口。
  // 「一条说周二、另一条说周二 3am」时应当收敛到 3am —— 这是聚合真正带来精度的地方，
  // 只取「最近一条」会丢掉更精确的那个。
  const anchored = hard.filter((a) => Number.isFinite(a.window?.dayNum));
  if (!anchored.length) return null;
  const dayNum = anchored[0].window.dayNum;
  const sameDay = (w) => w && Number.isFinite(w.dayNum) && w.dayNum === dayNum;

  const leads = anchored.filter((a) => sameDay(a.window));
  const lead = [...leads].sort(
    (a, b) =>
      (PRECISION_RANK[b.precision] ?? 0) - (PRECISION_RANK[a.precision] ?? 0) ||
      new Date(b.createdAt) - new Date(a.createdAt)
  )[0];

  // 证据链：所有指向这一天的推文（含只有时间、没有额度语境的那些）
  const evidence = list
    .map((a) => ({ a, w: a.window ?? a.candidateWindow ?? null }))
    .filter(({ a, w }) => a.level !== 'occurred' && sameDay(w))
    .map(({ a, w }) => ({
      id: a.id,
      createdAt: a.createdAt,
      text: a.text,
      url: a.url,
      // 是回复还是原创 —— 他大量时间线索埋在回复里，这个区别对复核很重要
      via: a.inReplyTo ? `回复 @${a.inReplyTo.account ?? '?'}` : '原创',
      weight: a.level === 'explicit' ? 'hard' : 'soft',
      contributes: a.level === 'explicit' ? '承诺了这一天' : '提到这一天（无额度语境）',
      // explicit 的 word / precision 挂在顶层（window 是 describeWindow 的产物，
      // 不含原始词）；hint 的则只在 candidateWindow 里。两处都要够得着。
      timeWord: a.timeWord ?? w.word ?? null,
      precision: a.precision ?? w.precision ?? null,
      // 表达本身存在第二种解读时（裸星期），这条线索只能算「待考」。
      // 不标出来的后果是：周三那句「11pm on a Tuesday」会被当成
      // 「他确认了下周二 23:00」使用 —— 而它完全可能是在回味刚过去的周二。
      ambiguous: !!w.note,
      note: w.note ?? null,
      // 指向这一天的哪个时段——有钟点就是钟点，没有就是整天
      from: w.from,
      to: w.to,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // 钟点线索单独交代采用情况。
  // 「看到了但没采用」与「根本没看到」在页面上必须能区分，
  // 否则用户没法判断是该信结论、还是该怀疑检测漏了。
  const clockHints = evidence
    .filter((e) => e.precision === 'instant')
    .map((e) => ({
      word: e.timeWord,
      from: e.from,
      to: e.to,
      adopted: e.weight === 'hard',
      why: e.weight === 'hard' ? '本条含额度承诺' : '本条无额度语境（他人活动/作息等），仅作旁证',
      ambiguous: e.ambiguous,
      id: e.id,
      via: e.via,
    }));

  return {
    dayNum,
    day: ymdLabel(dayNum),
    precision: lead.precision,
    // 窗口永远是**硬证据**的产物，soft 线索不参与
    window: { ...lead.window, precision: lead.precision },
    counts: {
      hard: evidence.filter((e) => e.weight === 'hard').length,
      soft: evidence.filter((e) => e.weight === 'soft').length,
      // 只到天、但当天有钟点线索的情况很常见（他就是这么写的）。
      // 这个计数让页面能说「有 2 条同日钟点线索未被采用」，
      // 而不是让用户以为系统没看见。
      clockHints: clockHints.length,
      clockAdopted: clockHints.filter((c) => c.adopted).length,
    },
    evidence,
    clockHints,
  };
}

/**
 * 把「预告」和**支撑它的推文**绑成一条 —— 一条预告，里面 N 条推文。
 *
 * ── 这一层为什么必须存在 ────────────────────────────────────────────
 * 老大的原话：「这些信息应该合并成一条预告，然后是一条预告里面 4 条推文。」
 * 在这之前，同一件事被拆成了三处呈现，读的人得自己拼：
 *   ① 预告横幅 —— 只挂**最新那条**推文的原文；
 *   ② 一行「另有 1 条指向同一时间窗口的预告（先铺垫、后宣布），不重复列出」；
 *   ③ 一个独立的可折叠块「综合 4 条推文指向 2026.09.22」。
 * 其中 ② 尤其糟：它陈述的是**我做了去重**这个实现细节，不是用户能拿去用的信息 ——
 * 页面上出现「另有 N 条不重复列出」，等于把内部取舍当成内容往外发。
 *
 * ── 合并的边界是「时间窗口」，不是「推文条数」 ──────────────────────
 * 一个窗口 = 一条预告；同一窗口下有几条推文，就是这条预告的几条证据。
 * 窗口不同则是**另一条**预告，各挂各的证据。所以按 `dayNum` 分组，
 * 而不是把所有 explicit 简单拍成一条 —— 后者会在「他先说周四、后改口周二」时
 * 把两个互斥的窗口混成一条，那比不合并更危险。
 *
 * @param {Array} signals    detectSignals 里的 explicit 列表
 * @param {object|null} hypothesis 跨推文聚合结果（只锚定一个日子）
 * @returns {Array} 按窗口开始时间升序的预告列表
 */
export function buildForecasts(signals = [], hypothesis = null) {
  const groups = new Map();
  for (const s of signals ?? []) {
    const w = s?.window;
    if (!w) continue; // 没有窗口就没有「预告」可言，只是情绪
    const key = Number.isFinite(w.dayNum)
      ? `d${w.dayNum}`
      : `t${w.fromTs ?? w.from}|${w.toTs ?? w.to}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const list = [...groups.values()].map((items) => {
    // 同一窗口里挑**表述最完整**的那条当正文：先比精度，再比时间新旧。
    // 他习惯先铺垫、后宣布 —— 后一条通常把话说全（「I promised a reset for Tuesday」）。
    const lead = [...items].sort(
      (a, b) =>
        (PRECISION_RANK[b.precision] ?? 0) - (PRECISION_RANK[a.precision] ?? 0) ||
        new Date(b.createdAt) - new Date(a.createdAt)
    )[0];

    const matched =
      hypothesis && Number.isFinite(lead.window.dayNum) && hypothesis.dayNum === lead.window.dayNum;

    // 证据 = 指向这个窗口的推文。正常情况下来自综合假设（同一天的硬承诺 + 同日提及）；
    // 假设只锚定一个日子，所以当另一个窗口存在时它自己撑起证据链 —— 退化为单条，
    // 但**结构保持一致**，渲染层不需要写两套。
    const evidence = matched && hypothesis.evidence.length
      ? hypothesis.evidence
      : [asEvidence(lead, 'hard', '承诺了这一天')];

    return {
      level: 'explicit',
      day: matched ? hypothesis.day : null,
      precision: lead.precision,
      // 窗口永远是硬证据的产物（与 buildHypothesis 同一口径）
      window: { ...lead.window, precision: lead.precision },
      // 正文取 lead：预告本身说的那句话
      text: lead.text,
      url: lead.url,
      reasons: lead.reasons ?? [],
      timeNote: lead.timeNote ?? '',
      createdAt: lead.createdAt,
      createdZones: lead.createdZones,
      // 同一窗口下他嘴上说了几次 —— 不是页面的主角，但它是「他反复在提」的证据
      sources: items.length,
      evidence,
      counts: {
        hard: evidence.filter((e) => e.weight === 'hard').length,
        soft: evidence.filter((e) => e.weight === 'soft').length,
      },
      clockHints: matched ? hypothesis.clockHints : [],
    };
  });

  // 先到的窗口排前面：真要出现两个未来窗口，先看更早到期的那个。
  return list.sort((a, b) => (a.window.fromTs ?? 0) - (b.window.fromTs ?? 0));
}

/** 把一条信号降级成证据条目（结构对齐 buildHypothesis 的 evidence）。 */
function asEvidence(a, weight, contributes) {
  return {
    id: a.id,
    createdAt: a.createdAt,
    text: a.text,
    url: a.url,
    via: a.inReplyTo ? `回复 @${a.inReplyTo.account ?? '?'}` : '原创',
    weight,
    contributes,
    timeWord: a.timeWord ?? null,
    precision: a.precision ?? null,
    ambiguous: false,
    note: null,
    from: a.window?.from ?? null,
    to: a.window?.to ?? null,
  };
}

/**
 * 最近一次「额度事件」的时刻（毫秒）。**不分 reset / credit** ——
 * 这里回答的是「他预告的那次发放，是否已经落地」，无论形式是重置还是发券，
 * 预告都已经兑现了。
 *
 * 实测：2026-09-23 02:23 那次正是 `credit`（发券）型，若只认 `reset`，
 * 这次「预告已兑现」根本判不出来。
 *
 * 与 `collect.mjs` 的 `resetFloorMs` 的关系（2026-09-23 起）：两者**都**把 credit
 * 算作一次重置（那条口径分歧已按 D-028 统一），但仍不是同一个函数 —— 这个取
 * 「所有记录的最大时刻」，那个还要按 `RESET_LIKE_TYPES` 过滤并往前减缓冲。
 * 保留两道是因为用途不同：这边只要「有没有落地」，那边要「该从哪儿开始扫」。
 *
 * @param {Array} records resets.json 的 records
 * @returns {number} 毫秒时间戳；没有记录时返回 0（调用方据此跳过这道判据）
 */
export function latestEventMs(records) {
  let max = 0;
  for (const r of records ?? []) {
    const t = new Date(r?.announced_at ?? 0).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/* ------------------------------- 入口 ------------------------------- */

/**
 * 扫描一批推文，产出信号结论。
 *
 * 分析按**时间窗**读，不按条数：
 *   · 下界 = 「now 往前 lookbackDays 天」与 `sinceMs`（上一次重置 - 缓冲）里**更早**的那个，
 *     谁更长听谁的 —— 既不漏掉近期公开发言，也保证「上一次重置以来」整段都在窗内；
 *   · 上界 = now。
 * 窗口原样写进结果（windowFrom / windowTo），可复核。
 *
 * 为什么不用「取最近 N 条」：条数口径会随他的发帖频率漂移 —— 发得勤时窗口缩到几天，
 * 发得少时又拉得很长。按时间切，含义稳定，而且与「上一次重置以来」这个产品口径同构。
 * 更关键的是：**超窗的推文不进窗，但留在 tweets.json 里不删** —— 数据不废弃，
 * 只是这一轮不参与判断。
 *
 * @param {Array} tweets
 * @param {object} opts
 * @param {number} opts.lookbackDays 最少回看多少天（默认 60）
 * @param {number} opts.sinceMs      时间窗的另一个候选下界（如「上次重置 - 缓冲」）
 * @param {number} opts.now          计算基准时刻
 * @param {number} opts.lastResetAt  最近一次额度事件的时刻（毫秒，见 latestEventMs）。
 *   用来判断预告是否**已经兑现**。不传的话只剩「窗口是否已过去」这一道判据，
 *   于是「窗口内已经重置过、但窗口还没走完」的预告会一直挂在页面上。
 */
export function detectSignals(tweets, opts = {}) {
  const sourceZone = opts.sourceZone ?? SOURCE_ZONE;
  const userZone = opts.userZone ?? USER_ZONE;
  const now = opts.now ?? Date.now();
  const lookback = opts.lookbackDays ?? 60;
  const account = opts.account ?? 'thsottiaux';

  const byLookback = now - lookback * DAY;
  const sinceMs = Number(opts.sinceMs ?? 0);
  const lowerBound = sinceMs > 0 ? Math.min(sinceMs, byLookback) : byLookback;

  const list = (tweets ?? [])
    .filter((t) => t && t.text && t.created_at)
    .filter((t) => {
      const at = new Date(t.created_at).getTime();
      return Number.isFinite(at) && at >= lowerBound && at <= now;
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const analyzed = list.map((t) => analyzeTweet(t, { sourceZone, userZone, account }));

  /* ── 已过期的预告不再展示 ────────────────────────────────────────────
   *
   * analyzeTweet 里那段「未来窗口」判定（约第 699 行）是**静态的**：它只跟**推文
   * 自己的发布时刻**比，回答的是「他发这条的时候，说的那天还在不在未来」。那个判据
   * 当时是对的，但它**不会随时间失效** —— 于是预告兑现之后，那条推文仍然留在 explicit 里，
   * 页面继续把它当成「还没发生、随时会发生」。
   *
   * 实测症状（2026-09-23）：他 09-22 预告「周二重置」（窗口到北京 09-23 14:59），
   * 而重置在 09-23 02:23 真的发生了。页面却还挂着「窗口已开启 · 随时可能重置」，
   * 倒计时归零定在那里 —— 一条**已经兑现**的预告，被展示成「随时会发生」。
   * 这比不显示更糟：它把读者的判断方向整个带反。
   *
   * 两道判据，任一成立即视为过期：
   *   ① 窗口已经过去（to < now）—— 预告落空或已兑现，都不该再作为「未来预告」出现
   *   ② 窗口开启之后已发生过重置（lastResetAt >= from）—— 预告兑现了
   *
   * 为什么 ② 不用「落在窗口内」当判据：重置也可能发生在窗口**结束之后**（他预告周二、
   * 实际周三才按按钮），那同样说明这条预告不再是「待验证的未来」。`>= from` 一并覆盖，
   * 语义是「这个窗口指向的那次重置，已经落地了」。
   *
   * ⚠ 连带效应是**有意**的：过滤发生在构造 hypothesis **之前**，所以「依据」里那些
   * 同日提及（"3am"、"coming in tuesday" 这类线索）会跟着一起撤走。一条预告只有一个去处 ——
   * 撤回它就要把它挂着的证据一起撤回，否则页面会既说「没有预告」、又列着 4 条依据。
   */
  const lastResetAt = Number(opts.lastResetAt ?? 0);
  const isExpiredForecast = (a) => {
    const w = a.window;
    if (!w) return false;
    const from = new Date(w.from).getTime();
    const to = new Date(w.to).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    if (to < now) return true;
    return lastResetAt > 0 && lastResetAt >= from;
  };
  const live = analyzed.filter((a) => !(a.level === 'explicit' && isExpiredForecast(a)));

  const explicit = live.filter((a) => a.level === 'explicit');
  const occurred = live.filter((a) => a.level === 'occurred');
  const hints = live.filter((a) => a.level === 'hint');
  const rejected = live.filter((a) => a.level === 'none' && a.rejected);

  // 优先级的语义：explicit 是「他对下一次重置给了时间」，可行动；
  // occurred 是「刚刚重置过」，是事实。两者都会在页面上并列展示，
  // 这里只决定横幅的主色调，所以 explicit 优先。
  const level = explicit.length
    ? 'explicit'
    : occurred.length
      ? 'occurred'
      : hints.length
        ? 'hint'
        : 'none';

  // 综合假设：把指向同一天的推文收成一条证据链，分明 hard / soft。
  // 这是「不只是抓到一条 reset 就结束」的落点 —— 单条结论之外，
  // 还要说清「有哪些推文共同指向这个时间、哪些没被采用、为什么」。
  // 用 live 而不是 analyzed：已过期的预告不能成为假设链的锚点，它的同日提及
  // 也不能再当证据（否则 forecasts 会挂着一条已经没有主语的证据链）
  const hypothesis = buildHypothesis(live);

  return {
    level,
    generatedAt: new Date(now).toISOString(),
    checkedTweets: list.length,
    lookbackDays: lookback,
    // 本轮实际取用的时间窗（可复核）。windowFrom 可能早于 lookbackDays ——
    // 当「上一次重置」在更早的时候，窗会相应放宽，好让整段重置周期都在窗内。
    windowFrom: new Date(lowerBound).toISOString(),
    windowTo: new Date(now).toISOString(),
    sourceZone,
    sourceZoneLabel: SOURCE_ZONE_LABEL,
    userZone,
    zones: dualZone(new Date(now).toISOString(), userZone, sourceZone, '北京时间', 'Tibo 当地时间'),
    latest: analyzed[0] ?? null,
    // ⚠ 这里**不做静默截断**。旧版对每类各取 `.slice(0, 5)`，而列表是按时间倒序的，
    // 于是被丢掉的是最早的那几条。现在：核心结论（explicit / occurred）全量保留；
    // hints / rejected 只作上限保护，一旦触顶会在 counts 与 truncated 里显式标出。
    //
    // 顺带纠正一处旧注释的推论。它举 2026-09-12 03:20「A reset and a quick update…」
    // 为例，说「被丢掉的恰好是最靠近上一次重置、本轮最相关的那些」，据此把
    // 「rejected 丢掉最早的」当成危险源。实测那条推文是 **occurred 级**（它声明的是
    // 「已经重置了」），从不进 rejected —— 本轮复核：它在 occurred 里，不在 rejected 里。
    // 所以对 rejected 而言「留最新、丢最旧」是安全的：带重置结论的推文走
    // explicit / occurred，而那两类不设上限。
    signals: explicit,
    occurred,
    hints: hints.slice(0, MAX_LISTED),
    rejected: rejected.slice(0, MAX_LISTED),
    // 综合假设：跨推文聚合的产物，回答「凭什么说这个时间」。
    hypothesis,
    // 预告：**一个时间窗口 = 一条预告**，每条挂着支撑它的推文（1 条或多条）。
    // 渲染层只认这个字段 —— 页面上不再有「横幅 + 另一行计数 + 另一个折叠块」
    // 这种把一个结论拆三处的排法（见 decisions.md 的 D-018）。
    forecasts: buildForecasts(explicit, hypothesis),
    counts: {
      scanned: list.length,
      explicit: explicit.length,
      occurred: occurred.length,
      hint: hints.length,
      none: live.length - explicit.length - occurred.length - hints.length,
      // 未截断的真实条数。触顶时 `rejected.length` 是**保留数**，两者不相等 ——
      // 渲染层要写「保留 X / 共 Y 条」就得有 Y（见 src/lib/render.mjs 的截断提示）。
      // 不复用 counts.none 是因为那是个减法结果，语义是「none 级的条数」；
      // 当前二者相等只因为每条 none 都被排除，不是定义上的等价。
      rejected: rejected.length,
    },
    truncated: hints.length > MAX_LISTED || rejected.length > MAX_LISTED,
  };
}
