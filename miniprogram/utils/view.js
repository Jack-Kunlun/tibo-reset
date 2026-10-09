/**
 * 数据 → 视图模型（纯函数，无副作用、不碰 wx.*）。
 *
 * 单独成文件的原因：这些是页面里唯一需要动脑的部分（信号怎么判醒目、
 * 预测数字怎么排版），而它们完全可以脱离小程序宿主运行。
 * 抽出来之后能在 Node 里直接喂数据做回归 —— 包括「真的来了明确信号时
 * 横幅长什么样」这种平时根本触发不到的路径。
 */

import { beijingParts, countdown, countdownGroups, fmtDate, fmtClock, fmtDateTime, fmtDay, fmtSpan, pct1, spanOf, toTs, trim1 } from './format.js';
// 与网页端**逐字同一份**（`src/lib/outlook.mjs` 由 scripts/build.mjs 同步过来）。
// 「下一次什么时候 / 可不可信 / 凭什么」这三件事的判据只该有一份实现。
import { buildOutlook } from './outlook.js';

const PRECISION_TEXT = {
  day: '全天',
  evening: '当晚',
  week: '整周',
  'week-part': '一周内的某几天',
  instant: '具体时刻前后',
};

// 数字与单位分开设字号，避免整段读数以大字挤占标签空间；预览复用同一份分段。
export function readoutParts(value) {
  return (String(value ?? '').match(/\d+(?:\.\d+)?|[^\d]+/g) || []).map((text, index) => ({
    key: index,
    text,
    numeric: /^\d/.test(text),
  }));
}

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
 * ── 预告是「一条预告 + 里面 N 条推文」，不再是「横幅 + 另一个折叠块」──
 * 老大的原话：「这些信息应该合并成一条预告，然后是一条预告里面 4 条推文。」
 * 合并逻辑在数据层（signals.mjs 的 buildForecasts），端上只是画出来 ——
 * 网页、小程序、采集日志共用同一份结论。
 *
 * 旧实现是 `explicit ? signals : hint ? hints : []` 三选一 —— 只要没有预告就退到
 * 线索档，于是横幅上显示的是「11pm on a Tuesday」这类与额度无关的推文，
 * 而真正的重置根本不出现。现在预告优先，线索只在没有预告时兜底。
 */
export function buildSignal(sig) {
  if (!sig) return { show: false, checked: 0, lookback: 60, windowFrom: '', program: { show: false } };

  // 每日重置窗口挂在**三条返回路径**上，而不是只在有预告时。
  // 它讲的是「这 N 天里每天都可能」—— 与有没有某一天的预告是两件事，
  // 只在预告分支里带上，就等于「没有预告时这条规则也不存在」。
  const program = programView(sig.program);

  // 预告：一个时间窗口一条。数据层给的是数组（理论上可能有多个未来窗口），
  // 端上只展示**最先到期**的那条 —— 手机屏幕上并列两块预告纯属噪音。
  const f = (sig.forecasts || [])[0] || null;
  if (f) return { ...forecastView(f), program };

  const hint = (sig.hints || []).find((s) => s.window) || null;
  if (hint) return { ...signalView(hint, 'hint'), program };

  return {
    show: false,
    program,
    checked: sig.checkedTweets,
    lookback: sig.lookbackDays,
    // ⚠ 数据层给的是 ISO 串。**必须过一遍格式化** —— 直接透传的话，
    // 页面上那行会显示成 `时间窗自 2026-07-25T02:15:29.011Z 起`：
    // 机器格式、又长到把右对齐的副行顶出卡片。真机截图实测。
    windowFrom: fmtDay(sig.windowFrom),
    hintCount: (sig.hints || []).length,
  };
}

/**
 * 每日重置窗口视图：他宣布「未来 N 天里每天要么发一个改进、要么给一次完整重置」。
 *
 * 与预告**并列但不是同一件事**：预告回答「哪一天」，这条回答「每一天都在射程内」。
 * 网页端（`render.mjs` 的 `renderProgram`）画的是同一份数据层结论，两边各画一次。
 *
 * 不套 `.sig` 那套醒目样式：预告才是这一区的主角，这条是补充事实。
 */
function programView(p) {
  if (!p || !p.window) return { show: false };
  // 宣布时刻的**双时区**文本在数据层就算好了，这里只拼不改 —— 与线索块的
  // `createdText` 完全同源（`buildProgram` 里的 `createdZones`）。
  // 端上自己算要依赖 Intl，部分安卓机型不可用；而且网页端读的是同一份，
  // 两边各算一次正是本项目反复吃过亏的地方。
  const cz = p.createdZones;
  const beijingRange = [
    { label: '开始', at: p.window.fromTs ?? p.window.from },
    { label: '结束', at: p.window.toTs ?? p.window.to },
  ].map(({ label, at }) => {
    const ts = toTs(at);
    if (!Number.isFinite(ts)) return { label, date: '—', weekday: '', time: '' };
    const parts = beijingParts(ts);
    return { label, date: `${parts.year}.${parts.month}.${parts.day}`, weekday: parts.weekday, time: `${parts.hour}:${parts.minute}` };
  });
  // 当地窗口保持原文的日历日粒度，不把跨度补成他没有承诺过的钟点。
  const localRange = String(p.window.sourceZone || '').split(/\s+[–—]\s+/).map((text, key) => {
    const parts = /^(.*)（(.*)）$/.exec(text);
    return { key, date: parts ? parts[1] : text, weekday: parts ? parts[2] : '' };
  });
  return {
    show: true,
    days: p.days ?? 0,
    daysLeft: p.daysLeft ?? 0,
    window: windowView(p.window),
    beijingRange,
    localRange,
    announcedText: cz ? `${cz.a.text} 北京 · ${cz.b.text} 当地` : '',
    announcedBeijing: cz?.a?.text || '',
    announcedLocal: cz?.b?.text || '',
    url: p.url || '',
  };
}

/**
 * 预告视图：窗口（结论）+ 依据推文（支撑）。
 *
 * 依据**默认收起**：手机一屏放不下「窗口 + 4 条推文 + 倒计时」，而倒计时是
 * 这一页的主角。摘要行照常显示「依据 4 条推文 · 2 条承诺 · 2 条同日提及」，
 * 归属关系一眼可见，要看详情点一下。
 */
function forecastView(f) {
  const w = f.window || null;
  const ev = (f.evidence || []).map(evidenceView);
  const c = f.counts || {};
  const unadopted = (f.clockHints || []).filter((x) => !x.adopted);

  return {
    show: true,
    level: 'explicit',
    badge: '明确信号',
    title: 'Tibo 已预告下一次额度重置',
    precision: PRECISION_TEXT[f.precision] || f.precision || '',
    headline: headlineOf(f, w),
    window: windowView(w),
    ev,
    evCount: ev.length,
    evOpen: false,
    evMix: [c.hard ? `${c.hard} 条承诺` : '', c.soft ? `${c.soft} 条同日提及` : '']
      .filter(Boolean)
      .join(' · '),
    // 「看见了但没采信」必须能与「根本没看见」区分 —— 前者是判断，后者是缺陷
    evNote: unadopted.length
      ? `另见 ${unadopted.map((x) => x.word).join(' / ')} 钟点线索，语境与额度无关，未纳入窗口`
      : '',
    text: f.text || '',
    timeNote: f.timeNote || '',
    reason: (f.reasons || []).join('、'),
    createdText: '',
    url: f.url || '',
  };
}

/**
 * 证据条目：这条预告依据的一条推文。
 *
 * 时间换算到北京时间并写明 —— 旧版这里贴的是 UTC，与页面其它地方自相矛盾。
 * 「承诺 / 提及」的标签不能省：前者决定窗口，后者只是旁证，混起来会让人
 * 以为这几条推文分量相等。正文截到 180 字，够看清说了什么，看全文点链接。
 */
function evidenceView(e) {
  // 走 format.js 的统一定义（toTs 已内含「非数字 / 空串 → NaN」的处理）
  const ts = toTs(e.createdAt);
  const when = Number.isFinite(ts) ? `${fmtDate(ts).slice(5)} ${fmtClock(ts)}` : '';
  return {
    id: e.id || '',
    when,
    weight: e.weight === 'hard' ? 'hard' : 'soft',
    tag: e.weight === 'hard' ? '承诺' : '提及',
    // 「原创 / 回复」的区别要留（他大量线索埋在回复里），但「回复 @xxx」太长，
    // 手机上跟时间、标签挤在一行会顶断。缩成「↩ @xxx」，信息没丢。
    via: e.via && e.via !== '原创' ? `↩ ${e.via.replace(/^回复\s*/, '')}` : '原创',
    word: e.timeWord || '',
    text: (e.text || '').slice(0, 180),
    url: e.url || '',
  };
}

/**
 * 窄屏上把「日期」与「时间」拆成两行。
 *
 * 为什么需要：北京时间那行的值实际是 `2026.09.22（周二）15:00 起` ——
 * **整串只有一个空格**（在 `15:00` 后面），而 `.wrow .v` 是 `word-break: keep-all`
 * （禁止汉字间断行，只在空格处断）。402pt 真机上整串放不下
 * （实测约需 352rpx，可用宽度只有 313rpx），于是唯一的那个断点被用上，断成
 *
 *     2026.09.22（周二）15:00
 *     起
 *
 * 「起」孤零零一行 —— 真机截图实测，不是推测。注意 `（周二）` 与 `15:00` 之间
 * **没有空格**，所以「换个空格」那类修法在这儿根本无从下手。
 *
 * 与其去挤宽度（差 39rpx，挤到了也经不起字体渲染的细微差异），不如把断点
 * **显式放到该在的位置**：
 *
 *     2026.09.22（周二）
 *     15:00 起
 *
 * 判据只认「前面有内容 + 后面跟 HH:MM」这一种形态。没有时间的值
 * （如 `2026.09.22（周二） 全天`）原样返回 —— 它本来就放得下。
 * 已含换行的串原样返回，保证重复调用是幂等的。
 */
export function breakBeforeTime(s) {
  if (typeof s !== 'string' || s.includes('\n')) return s;
  const m = /^(.*?)(\d{1,2}:\d{2}.*)$/.exec(s);
  if (!m || !m[1].trim()) return s;
  return `${m[1].trimEnd()}\n${m[2]}`;
}

/** 窗口视图（预告与线索共用）。 */
function windowView(w) {
  if (!w) return null;
  return {
    // 两行都过一遍：窄屏上整串放不下时，把断点放到「日期 / 时间」之间，
    // 而不是让它落在唯一的那个空格上、把尾词挤成孤字（`全天` 那行没有时间，不受影响）。
    sourceZone: breakBeforeTime(w.sourceZone),
    userZone: breakBeforeTime(w.userZone),
    srcOffset: (w.zones && w.zones.b && w.zones.b.offset) || '',
    usrOffset: (w.zones && w.zones.a && w.zones.a.offset) || '',
    diffText: (w.zones && w.zones.diffText) || '',
    // 区间说明。由数据层按粒度决定：「当地一整天」时北京那行只给开启那一刻，
    // 剩下的范围退到这里说一句；整周那种含糊粒度则整行本来就是区间，这里为空。
    rangeNote: w.rangeNote || '',
    // 倒计时的锚点（北京时间的开启时刻）。**必须显示在倒计时旁边** ——
    // 只给一个跳动的数字、不说它数到哪一刻，用户没法核对，
    // 那正是「你这时间也不对啊」这条反馈的来源。
    openText: w.openText || '',
    // 数字时间戳直通，供页面做每秒倒计时（不做字符串反解析）
    fromTs: w.fromTs ?? null,
    toTs: w.toTs ?? null,
  };
}

/**
 * 线索视图：**没有预告时**才出现的弱依据兜底。
 *
 * 线索是没有证据链可挂的单条推文（有时间没意图、或有意图没时间），
 * 所以形态退化成「一条推文 + 它的窗口」，与预告共用窗口渲染。
 */
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
    window: windowView(w),
    // 没有依据推文可挂 → evCount 为 0，模板据此渲染单条原文
    ev: [],
    evCount: 0,
    evOpen: false,
    evMix: '',
    evNote: '',
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
  // 三项间隔统计走 spanOf：大字给主单位数值、小字给「天 17 小时」这样的单位串。
  // 与网页端 renderMetrics 同口径 —— 原来写死 `toFixed(1) + '天'`，一落到
  // 「0.9 天」就变成要读者自己换算的小数，而那恰恰是最常出现的情形。
  const mean = spanOf(chart.mean);
  const median = spanOf(chart.median);
  const longest = spanOf(chart.longest);
  return [
    { k: '平均间隔', v: mean.big, u: mean.unit, note: '被极端值拉高' },
    { k: '中位间隔', v: median.big, u: median.unit, note: '一半情况比这更快', hi: true },
    { k: '最长等待', v: longest.big, u: longest.unit, note: '极端长尾' },
    { k: '记录总数', v: String(chart.count), note: `${fmtDay(chart.firstAt)} 起` },
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

/* ------------------------------ 预测总览 ------------------------------ */

/** 北京时间字段 → 主卡那一行：`10.08` 大字 + `周四 15:00`（与网页端 `etaStamp` 同口径） */
function etaStamp(ts) {
  const p = beijingParts(ts);
  return { md: `${Number(p.month)}.${Number(p.day)}`, wd: p.weekday, hm: `${p.hour}:${p.minute}` };
}

/**
 * 预测总览：把「下一次什么时候 / 可不可信 / 凭什么」并成**一张卡**。
 *
 * 判据全部来自共享模块 `outlook.js`（与网页端逐字同一份），
 * 这里只做**排版**：时间怎么摆、句子怎么拼。两端各拼一句，数字一定同源。
 *
 * ── 为什么这一块必须在首屏，且排在规则与依据之前 ────────────────────
 * 改版前小程序首屏的第一块是「每日重置窗口」，第二块才是有没有预告，
 * 而「距上次重置多久」那个大计数器排在第三块 —— 三个块分别在回答
 * 「规则是什么 / 有没有公告 / 已经等了多久」，**没有一块在回答「下一次什么时候」**。
 * 用户要的答案要在首屏自己拼，所以这一页此前更像记录页。
 * ⚠ 2026-10-08 起它上面还有「已经等了多久」（事实在前、推断在后，见 D-047），
 *   所以它不再是首屏**第一**块 —— 但「答案排在规则与依据之前」这条没变：
 *   `.prog`（每日重置窗口，见 D-049）与 `.bc-grid`（依据三卡）至今都在它之后。
 *
 * ── 状态与置信度是两个轴，不能合并 ─────────────────────────────────
 * `status`（观察中 / 高概率 / 已确认）说的是**依据的来源**；
 * `confidence`（高 / 中 / 低）说的是**这个来源值多少分**。公告档可以
 * 「已确认 + 置信度中」（他把话说死了，但样本本身不多）；推算档最高只到「中」。
 *
 * @param {object} chart  `state.chart`
 * @param {object} pred   `state.prediction`
 * @param {object} sig    `state.signals`
 * @param {number} now    锚点（用 `state.generatedAt` 解析出来的那个，不是 Date.now()）
 *                        —— 快照态下如果用自己的当前时刻，倒计时会指向一个
 *                        与页面其余数字不同源的时刻。
 */
export function buildOutlookView(chart, pred, sig, now) {
  const o = buildOutlook({ chart, prediction: pred, signals: sig, now });
  if (!o) return null;

  const eta = etaStamp(o.etaAt);
  const b = o.brief;

  // 一句话依据摘要：**只用 o.brief 给的数字原料**拼句子（数字同源，措辞各端自写）
  let brief;
  if (o.etaKind === 'announced') {
    const bits = [];
    if (b.announcedHard) bits.push(`${b.announcedHard} 条承诺`);
    if (b.announcedSoft) bits.push(`${b.announcedSoft} 条同日提及`);
    brief = `Tibo 已给出公告${bits.length ? `（${bits.join(' · ')}）` : ''}，预计时间取窗口开启时刻。`;
  } else {
    const n = b.intervals ? `按 ${b.intervals} 次历史间隔的节奏推算` : '按历史间隔的节奏推算';
    const scan =
      b.scanned == null
        ? ''
        : `本轮扫描 ${b.scanned} 条推文${b.hints ? `，${b.hints} 条时间线索` : ''}均不足以构成预告。`;
    brief = `没有公告，${n}。${scan}`;
  }

  // 区间：announced 档就是公告窗口本身，model 档是 80% 双侧区间 [q10, q90]。
  // 两档的**标签必须不同** —— 把公告窗口叫成「80% 区间」是把承诺说成估计。
  const band =
    o.band && Number.isFinite(o.band.fromAt) && Number.isFinite(o.band.toAt)
      ? `${fmtDateTime(o.band.fromAt).slice(5)} – ${fmtDateTime(o.band.toAt).slice(5)}`
      : '';

  return {
    show: true,
    /** `announced` = 有公告（ETA 是窗口开启时刻）/ `model` = 无公告（ETA 是中位推算）。
     *  两档的**措辞必须能分开**，所以给它一个自己的字段，别让页面从 status 反推。 */
    etaKind: o.etaKind,
    status: o.status,
    statusClass: `status-${o.status}`,
    statusLabel: o.statusLabel,
    statusNote: o.statusNote,
    confidence: o.confidence,
    confidenceClass: `confidence-${o.confidence}`,
    confidenceLabel: o.confidenceLabel,
    /** 置信度条按 1/2/3 档拉开宽度，与网页端 `.conf-bar` 的 <i><i><i> 同义 */
    confidenceW: Math.round((o.confidenceRank / 3) * 100),
    etaNote: o.etaNote,
    // 三行依据只拿共享 outlook 判定给出的数字；端上不从散文摘要里反解析。
    briefData: {
      intervals: b.intervals,
      announcedHard: b.announcedHard,
      announcedSoft: b.announcedSoft,
    },
    md: eta.md,
    dateDigits: [...eta.md].map((value, index) => ({
      key: `${index}-${value}`,
      value,
      delay: `${(index * 0.055).toFixed(3)}s`,
    })),
    wd: eta.wd,
    hm: eta.hm,
    etaDetail: o.etaKind === 'announced'
      ? `${eta.wd} · ${eta.hm} · 北京时间 · ${o.etaNote}`
      : `${eta.wd} · 北京时间 · 历史中位推算`,
    /** 倒计时锚点（时间戳直通，页面每秒据此重算，不做字符串反解析） */
    etaAt: o.etaAt,
    cd: null,
    bandLabel: o.etaKind === 'announced' ? '公告窗口' : '80% 区间',
    band,
    brief,
    // 「预测算于」= 这条结论是什么时候算出来的。用 o.now（同一锚点），
    // 不用 Date.now() —— 否则倒计时和它自己那句时间会互相矛盾。
    updatedText: `${fmtDateTime(o.now).slice(5)} 北京`,

    /** 依据卡的判据原样透传（视图层**不重算**）。
     *
     *  卡②底部那句结语的主语就是 `checks` 本身，`buildForecast` 只负责把它放进卡里；
     *  不透传的话那句话会渲染成空 —— 一张把「准不准」写成四行百分比、却不给结论的卡。
     *  `evidence` 同理：第四行「重采样波动」的原料（`medianRel` + 阈值）在里面。 */
    checks: o.checks,
    evidence: o.evidence,
  };
}

/**
 * 预测总览的大倒计时。
 *
 * 抽成共享函数而不是写在页面里，是因为**文案必须只有一份**：
 * 页面（每秒 tick）与 `scripts/preview-miniprogram.mjs`（本地预览）都要用它，
 * 而预览是手写副本 —— 各写一份的结果是预览上那句措辞与真机不一致，
 * 于是「预览通过」变成一句没有根据的话。
 *
 * ⚠ 过点之后的措辞要**分档**：公告档说「窗口已开启」，推算档说「已到中位预测时刻」。
 *   拿一句话糊住两档，公告档就会在自己没有「中位预测」的时候提「中位预测」。
 *
 * @returns {{over:boolean, groups:Array, label:string}|null} 没有 ETA 时返回 null
 */
export function predCountdown(pred, now) {
  if (!pred || !Number.isFinite(pred.etaAt)) return null;
  const cd = countdown(pred.etaAt, now);
  const allGroups = countdownGroups(cd);
  // 主卡只显示相邻的两个时间单位：一天以上为「天 / 时」，一小时以上为
  // 「时 / 分」，更短则为「分 / 秒」。完整精度仍由锚点计算，展示不再铺四列。
  const groups = cd.d >= 1 ? allGroups.slice(0, 2) : cd.h >= 1 ? allGroups.slice(1, 3) : allGroups.slice(2, 4);
  const over =
    pred.etaKind === 'announced' ? '公告窗口已开启 · 随时可能重置' : '已到中位预测时刻 · 随时可能重置';
  return {
    over: cd.over,
    groups,
    label: cd.over ? over : '预计还需等待',
  };
}

/* ------------------------------ 预测 ------------------------------ */

/**
 * 预测区块视图模型。
 *
 * 只输出数字与单位，不写「本模型不预测什么」这类关于模型自身的说明；
 * 但**数据类披露必须留**：覆盖率、区分度、样本量 —— 那是数字，不是散文。
 */
export function buildForecast(pred, o) {
  if (!pred || !pred.prediction) return null;

  const p = pred.prediction;
  const cal = pred.calibration;
  const sk = pred.skill;
  const ev = o?.evidence ?? {};
  const ck = o?.checks ?? {};

  // 时长字段两档精度（与网页端同样的理由）：主数字用 `spanOf` 的完整档
  // （大字 + 单位小字，见卡①）；挤在同一行里的区间与阶段子行用 `fmtSpan`。
  const q50 = spanOf(p.q50);

  const nearZero = Math.abs(sk.score) < 0.05;
  const skillShort = nearZero
    ? '≈ 无区分力'
    : sk.score > 0
      ? `优于盲猜 ${(sk.score * 100).toFixed(1)}%`
      : `略差于盲猜 ${(sk.score * 100).toFixed(1)}%`;

  const cov50Ok = Math.abs(cal.cov50 - 0.5) < 0.1;
  // ⚠ 双侧区间 [q10, q90] 的实测覆盖率是 `covBand80`，**不是** `cov80`。
  //    `cov80` 是单侧上界 P(T ≤ q80)：它回答「上界会不会被顶破」，
  //    拿它论证上面那个双侧区间可不可信是两回事。实测两者在本数据集上
  //    分别 83.3% / 83.3% 恰好接近 —— 那是巧合，不是口径对得上。
  //
  // ⚠ 卡②里「过没过」的三项（覆盖率 / 样本量 / 重采样波动）**直接读 `ck`**
  //    （outlook.js 给出的判据），这里不再照阈值自判一遍 —— 判据漂了，
  //    卡片底部那句结语就会说一件页面上并不成立的事。
  const rel = Number.isFinite(ev.medianRel) ? ev.medianRel : null;
  const maxRel = ev.thresholds?.maxMedianRel ?? 1.5;

  const phases = pred.phases ?? [];

  return {
    // 节头那句副文案：公告档下这三张卡**不是**结论的依据（结论来自公告），
    // 所以措辞要跟着换 —— 与网页端同一句话。
    hint:
      o?.etaKind === 'announced'
        ? '结论来自公告，以下是模型侧的辅助数字'
        : '结论在上方，这里是它凭什么成立',

    // ① 中位剩余等待：多长时间、区间多宽、各时间窗的累积概率。
    wait: {
      num: q50.big,
      unit: q50.unit,
      // 80% 双侧区间的端点是 [q10, q90]（0.9 − 0.1 = 0.8）。曾经取 q25 ——
      // 那是 65% 区间，标成「80% 区间」就是在页面上写一句当时并不成立的话
      // （AGENTS.md 文案红线第 4 条）。网页端已同步修正。
      range: `80% 区间 ${fmtSpan(p.q10)} – ${fmtSpan(p.q90)}`,
      bars: p.horizons.map((h) => ({
        label: h.label,
        w: Math.max(1, Math.min(100, h.p * 100)).toFixed(1),
        pv: pct1(h.p),
      })),
      // 概率没有做过校准。这句必须留在数字旁边，不能用散文代替 ——
      // 它报的不是系统有多好，而是这些数字**偏低**（实际发生率通常更高）。
      warn: '概率未经校正 · 实际发生率通常更高',
    },

    // ② 样本外回测：这个模型在它没见过的样本上准不准。
    //
    // 四行分两类：前两行是覆盖率，第三行是区分度，第四行是重采样波动。
    // ⚠ 第四行**不能省**：它与样本量、覆盖率一起直接决定主卡上那个置信度，
    //   而卡底那句结语正是拿它们三个当主语的。少一行，那句话就会指着
    //   一个页面上看不见的东西说话。
    backtest: {
      n: cal.n,
      minN: ev.thresholds?.minBacktestN ?? 30,
      rows: [
        {
          k: '50% 分位覆盖率',
          v: pct1(cal.cov50),
          ok: cov50Ok,
          j: cov50Ok ? '一半的中位估计落在实际值以下' : '偏离 50% 的目标',
        },
        {
          // 名字必须与端点的口径一致 —— 叫「分位覆盖率」而值是双侧区间覆盖率，
          // 读者会把 83.3% 理解成「有 83.3% 的情况落在 q80 以下」。
          k: '80% 区间覆盖率',
          v: pct1(cal.covBand80),
          ok: !!ck.covOk,
          j: ck.covOk ? '区间宽度合适' : '区间偏窄或偏宽',
        },
        {
          k: '7 天区分度',
          v: skillShort,
          // 实测这个模型在 7 天尺度上与盲猜持平，所以这一行**恒为未达标** ——
          // 不是没算，是算出来就是这个数。
          ok: sk.score > 0.05,
          j: `Brier ${sk.brier.toFixed(3)} / 盲猜 ${sk.baseline.toFixed(3)}`,
        },
        {
          k: '重采样波动',
          v: rel == null ? '—' : `${rel.toFixed(1)}×`,
          ok: !!ck.relOk,
          j: `换一批样本后中位估计的相对波动（阈值 ≤ ${maxRel}）`,
        },
      ],
      // 结语来自共享模块的 `checks.note` —— 那句话的主语就是 `checks` 本身，
      // 两端各拼一句会让同一句断言有两个可以各自漂移的副本。
      note: ck.note ?? '',
    },

    // ③ 节奏在加速：分段平均间隔。历史节奏本身在变，模型读的就是它。
    pace: {
      phases: phases.map((ph, i) => {
        const sp = spanOf(ph.mean);
        return {
          i: i + 1,
          from: fmtDay(ph.from),
          to: fmtDay(ph.to),
          mean: sp.big,
          unit: sp.unit,
          n: ph.n,
          max: fmtSpan(ph.max),
        };
      }),
      note:
        phases.length > 1
          ? `平均间隔从 ${fmtSpan(phases[0].mean)} 降到 ${fmtSpan(
              phases[phases.length - 1].mean
            )}。`
          : '只有一段，还没有可比较的节奏变化。',
    },
  };
}
