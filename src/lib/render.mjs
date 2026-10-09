/**
 * 渲染层：把所有内容（图表 SVG、指标、时间线、判定、信号）在 Node 里算好，
 * 产出纯 HTML 片段。
 *
 * **两个消费者，同一套代码**（组装在 src/lib/page.mjs）：
 *   1. scripts/build.mjs   —— 构建期出 dist/index.html（Pages + 镜像兜底）
 *   2. server/index.mjs    —— 请求时实时渲染，数据一变刷新即新，不经构建
 * 两份产物因此逐字节同源，不会各自漂移。
 *
 * 为什么不放在浏览器里跑？
 *  - 不依赖 JS 运行环境，脚本被限制的 WebView 也能正常显示
 *  - 内联 SVG 一律带 width/height 属性，避免靠 height:auto 撑高时塌成 0
 *  - 页面加载即出图，没有白屏闪烁
 *
 * ⚠ 所有面向用户的时间一律按 **Asia/Shanghai** 渲染。
 *   曾经用本地时区，结果部署到 GitHub Actions（runner 是 UTC）后页面上全是 UTC 时间。
 */

import { fmtDateIn, fmtDateTimeIn, partsIn, dualZone } from './chart-data.js';
import { buildOutlook } from './outlook.mjs';
import { survivalScene, stripScene, histogramScene, rhythmScene } from './scene.js';
import { sceneToSvgTag } from './svg.mjs';

const CJK = 'Asia/Shanghai';
const DAY = 86_400_000;

/* ------------------------------ 格式化 ------------------------------ */

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (iso) => fmtDateIn(iso, CJK);
const fmtTime = (iso) => {
  const p = partsIn(iso, CJK);
  return `${p.hour}:${p.minute}`;
};
/**
 * 带秒的钟点（HH:MM:SS）。只给页首「观测中」用 —— 那一处显示的是**当前北京时间**，
 * 页面脚本每秒推进它，静态兜底值也得是同样的位数，否则 JS 一接管就会换宽度。
 */
const fmtTimeSec = (iso) => {
  const p = partsIn(iso, CJK);
  return `${p.hour}:${p.minute}:${p.second}`;
};
const fmtDateTime = (iso) => fmtDateTimeIn(iso, CJK);

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 属性值转义：比正文多一个双引号，否则 meta content 会被提前闭合 */
const attr = (s) => esc(s).replace(/"/g, '&quot;');

const pct1 = (x) => (x * 100).toFixed(1) + '%';

/* --------------------------- 时长格式化 --------------------------- */

/**
 * 把一段时长（单位：天，可含小数）拆成「主数字 + 单位串」。
 *
 * 口径（2026-09-30 定）：**保留最高的非零单位当主数字，再给下一级做精度**
 *   ≥ 1 天    → `6` + `天 17 小时`
 *   < 1 天    → `20` + `小时 41 分`
 *   < 1 小时  → `41` + `分 20 秒`
 *
 * 为什么不一律换成小时 / 秒：6.7 天 = 160.8 小时，最长等待 67.7 天 = 585 万秒 ——
 * 读者得先心算才知道量级，那不是「更直观」，是「更难懂」。所以用「天/小时/分」
 * 里最高的那个非零单位当锚点，下一级只用来补精度。
 *
 * ⚠ 入参必须是**原始浮点天数**，不要先 `toFixed` 再传进来：先四舍五入会凭空造误差
 *   （0.8645 天 = 20 小时 44 分，先 `toFixed(1)` 就变成 20 小时 38 分）。
 */
export function spanOf(days) {
  if (!Number.isFinite(days) || days < 0) return { big: '—', unit: '', text: '—' };
  const total = Math.round(days * 86_400);
  const D = Math.floor(total / 86_400);
  const H = Math.floor((total % 86_400) / 3600);
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

/** 一句话里用的完整串（`big unit`）。要拆成大字 + 小字时直接用 `spanOf`。 */
export const fmtSpan = (days) => spanOf(days).text;

/**
 * 短版（只到主单位，不到「分」）的实现在 `scene.js` 里 —— 因为那份文件会被
 * 逐字同步到小程序端，必须自包含，所以它自带一个。这里不再重复一份，
 * 免得将来只改了一边。要用就 `import { fmtSpanShort } from './scene.js'`。
 */

/* --------------------------- 倒计时 / 判定 --------------------------- */

const REEL_ITEMS = Array.from({ length: 10 }, (_, i) => `<i>${i}</i>`).join('');

/**
 * 一个「数字卷轴」位。
 *
 * 关键：**初始位置在构建时就写死**（`translateY(-N em)`）。
 * 所以脚本被禁用时显示的是正确数字，而不是停在 0；
 * 脚本可用时才由 ticker 改这个 transform，从而产生滚动动画。
 */
const reel = (digit) =>
  `<span class="reel"><span class="strip" style="transform:translateY(-${digit}em)">${REEL_ITEMS}</span></span>`;

const reels = (str) => [...str].map((ch) => reel(Number(ch))).join('');

const group = (key, str, unit) =>
  `<span class="grp" data-g="${key}"><span class="reels" aria-hidden="true">${reels(str)}</span><span class="unit">${unit}</span></span>`;

/** 把一段毫秒拆成 天/时/分/秒 四个卷轴组。两块倒数共用这一处拆法。 */
function groupsFromMs(ms) {
  const left = Math.max(0, ms);
  return (
    group('d', String(Math.floor(left / DAY)), '天') +
    group('h', pad(Math.floor((left % DAY) / 3_600_000)), '时') +
    group('m', pad(Math.floor((left % 3_600_000) / 60_000)), '分') +
    group('s', pad(Math.floor((left % 60_000) / 1000)), '秒')
  );
}

/** 距预测重置时刻的倒数。锚点、口径与 `.sig-cd` 那套一致，只是这里是主角。 */
export function renderEtaCounter(o) {
  return groupsFromMs(o.etaAt - o.now).replace('<span class="unit">时', '<span class="unit">小时');
}

/**
 * 页首「已经等了多久」的卷轴数字（天 / 时 / 分 / 秒四位）。
 *
 * ── 为什么要它（2026-10-08）──────────────────────────────────────────
 * 这一块此前是一串**静态文本**（`fmtSpan(sinceDays)`，如「5 小时 44 分」）。
 * 结果是：全页最显眼的那个数字反而不会动，而它下面的主卡倒数、以及小程序端
 * 同一个数字都在滚。老大原话：「已经等了多久也应该有时间滚动效果」。
 * 现在与主卡共用同一套卷轴位（`.grp` / `.reel` / `.strip`）—— 同一个量只该有
 * 一种动法，页首与倒数长得一样，读者不必学第二套视觉。
 *
 * ── 口径为什么取 `Math.round(days * 86_400)` 而不是现成的 `parts()` ──
 * 必须与 `spanOf` **同一个表达式**（它内部就是 `Math.round(days * 86_400)`）。
 * `parts()` 是先把毫秒**向下取整**到秒再拆，与本式在秒的小数部分 ≥ .5 时差一秒：
 * 同一个「等了多久」会在页首卷轴上读成「23 时 59 分 59 秒」，而「历史规律」那道
 * 「现在 X」标签（走 `spanOf`）读成「1 天」—— 每天有 0.6 秒的窗口会这样，
 * 随手截图撞不上，线上撞上了也解释不清。取同一个 `total`，两边**结构上**不可能
 * 不一致，而不是靠「通常撞不上」。
 *
 * 初始位置（`translateY(-N em)`）在渲染时就写死，所以脚本被禁用时数字依然正确，
 * 只是不再滚动 —— 与主卡倒数同样的渐进增强。
 */
export function renderElapsedCounter(m) {
  const total = Math.max(0, Math.round(m.sinceDays * 86_400));
  return (
    group('d', String(Math.floor(total / 86_400)), '天') +
    group('h', pad(Math.floor((total % 86_400) / 3_600)), '时') +
    group('m', pad(Math.floor((total % 3_600) / 60)), '分') +
    group('s', pad(total % 60), '秒')
  );
}

/**
 * 判定分档。页面与 OG 卡片共用这一处阈值 —— 分档口径写在两处迟早会漂。
 * 只返回「档位 + 文案」，颜色交给各自渲染层（页面读 CSS 变量，SVG 要用字面色值）。
 */
export function verdictOf(m) {
  if (m.pct >= 0.88) return { cls: 'v-rare', text: '罕见的长等待' };
  if (m.pct >= 0.7) return { cls: 'v-long', text: '明显偏久' };
  if (m.pct >= 0.5) return { cls: 'v-watch', text: '已进入偏长区间' };
  return { cls: 'v-calm', text: '仍在常规节奏内' };
}

export function renderVerdict(m) {
  const v = verdictOf(m);
  const tail = `历史上 ${100 - Math.round(m.pct * 100)}% 的间隔比现在更长`;
  return { cls: v.cls, html: `<b>${v.text}</b> · ${tail}` };
}

/* ------------------------------ 指标条 ------------------------------ */

/**
 * 样本摘要的六个格子。**值在上、标签在下**（设计稿如此）。
 *
 * 为什么值放前面：这一栏是「上面那些结论的原料」，读者扫的是数字本身，
 * 标签只在认不出这个数字时用来解释它。标签占先会把六个数字推到第二眼。
 * 单位走 `<small>` 单独成段（`6` + `天 13 小时`），与页面别处的「大值 + 小单位」同形。
 */
export function renderMetrics(m) {
  // 三项间隔统计都走 spanOf：大字给主单位数值、小字给「天 17 小时」这样的单位串。
  // 之前写死 `toFixed(1) + '天'`，在「6.7 天」这种量级上没问题，但一落到
  // 「0.9 天」就变成读者要自己换算的小数 —— 而 0.9 天恰恰是最常出现的情形。
  const mean = spanOf(m.mean);
  const median = spanOf(m.median);
  const longest = spanOf(m.longest);
  const items = [
    { k: '平均间隔', v: mean.big, u: mean.unit, note: '被极端值拉高' },
    { k: '中位间隔', v: median.big, u: median.unit, note: '一半情况比这更快', hi: true },
    { k: '最长等待', v: longest.big, u: longest.unit, note: '极端长尾' },
    { k: '记录总数', v: m.count, note: `${fmtDate(m.firstAt)} 起` },
    { k: '普通重置', v: m.count - m.creditCount, note: '额度直给' },
    { k: '发券型', v: m.creditCount, note: '改成给券' },
  ];
  return items
    .map(
      (it) => `<div class="metric${it.hi ? ' hi' : ''}">
    <div class="v">${it.v}${it.u ? `<small>${it.u}</small>` : ''}</div>
    <div class="k">${it.k}</div>
    <div class="note">${it.note}</div>
  </div>`
    )
    .join('');
}

/* ------------------------------ 信号横幅 ------------------------------ */

const LEVEL_TEXT = {
  explicit: { label: '明确信号', title: 'Tibo 已预告下一次额度重置' },
  hint: { label: '线索', title: '有一条与额度相关的时间线索' },
  none: { label: '暂无信号', title: '最近没有检测到重置信号' },
};
const PRECISION_TEXT = {
  day: '全天',
  evening: '当晚',
  week: '整周',
  'week-part': '一周内的某几天',
  instant: '具体时刻前后',
};

/**
 * 信号横幅。
 *
 * 规范（缺一不可）：
 *   1) 明确信号必须给出**时间窗口**，不是「快了」这种空话
 *   2) 同时给出 Tibo 当地时间和北京时间 —— 推文的时间语境在人家那边
 *   3) 标出时差，跨夏令时会变
 *   4) 原文可追溯，并写明「依据什么词判定的」
 *   5) 没有信号时也要有一行状态，否则用户会怀疑检测是不是坏了
 *
 * 这一区**只讲未来**：预告（可行动）> 线索（弱依据兜底）。
 *
 * ⚠ 已经发生过的重置**不在这里列举**。它是**往回看**的事实，而本区回答的是
 *   「下一次什么时候」。同一段事实的载体已经有三个 —— 顶部的「距上次重置 N 天」
 *   倒计时、下方的「最近记录」、以及每轮的采集日志 —— 再在页首铺两块原文卡片，
 *   既把倒计时挤到首屏之外，也只是复述。检测能力保留在数据层（`signals.occurred`
 *   照常识别与计数），只是不参与这里的呈现。
 *
 * 旧实现是 `level === 'explicit' ? signals : level === 'hint' ? hints : []` ——
 * 只要没有明确预告就退到线索档，于是页面上出现的是 5 条随机营销推文
 * （「11pm on a Tuesday」），而真正的重置根本不显示。现在预告优先，线索只在
 * 没有预告时兜底。
 */
/**
 * ⚠ 这一区**不再**显示「留档超出上限」提示（2026-10-07 撤掉，见 decisions.md D-039）。
 *
 * 它原先是一个 `truncationNote(sig)`：`truncated` 为真时渲染一行
 * 「留档超出上限 · 排除项保留了最近的 200 / 共 241 条」，动机是不许静默截断。
 * 但那条红线的落点在**数据** —— AGENTS.md 只要求「`hints` / `rejected` 触顶会置
 * `truncated: true`」，由检测层（`detectSignals`）与采集日志负责，从没要求页面复述。
 *
 * 页面复述它有两处说不通：
 *   1) 它报的 `rejected`（排除项）**两端都不渲染**。向读者汇报一份他看不见的档案的
 *      容量，读者既无法核对也无法行动，只会把它读成故障 —— 它长得本来就象状态栏，
 *      还紧挨着真正的状态行（「时间窗内 … 没有检测到重置预告」）。
 *   2) 措辞是**档案口径**（「保留了最近的 200 条」）。即便换成 `hints`（页面确实用到），
 *      页面展示的也是 **0 或 1 条**线索、从不展示 200 条 —— 「保留多少条」是档案的属性，
 *      不是视图的属性。视图该保证的是**它自己给出的数字是真的**：闲时那行的线索数
 *      已改用 `counts.hint`（未截断的真实条数），见下面那段。
 *
 * 而且触发面在扩大：`rejected` 于 2026-10-05/06 之间越过 200（D-019 当时按
 * 「62 条 / 60 天」外推，预估要 194 天，实际 **13 天**），因为它随**窗内推文量**走
 * 而不是随天数走（`scanned` 从 90 涨到 295）。所以这行提示一旦出现就是**常驻**的。
 */

/**
 * 每日重置窗口：他宣布「未来 N 天里每天要么发一个改进、要么给一次完整重置」。
 *
 * ── 为什么不并进预告那块 ────────────────────────────────────────────
 * 预告回答的是「下一次是哪一天」；这条回答的是「这 N 天里**每一天**都在射程内」。
 * 它是**下界**，不是某一个窗口。页面上的「还要等多久」是按历史间隔外推的中位数，
 * 读者很容易把它读成「在这之前不会重置」—— 而这条规则恰好把这个读法反过来，
 * 所以它必须自己显形，不能靠读者从别处推。
 *
 * ── 为什么排在预测区之后、依据之前、并在宽屏做成一行 ────────────────
 * 它是一条**规则**，不是结论。旧版排在首屏第一块，于是第一眼读到的是射程范围，
 * 而不是「下一次什么时候」。2026-10-09 老大要求「放在预测下方」，于是它在
 * **信号区之后、预测依据之前**：仍在结论与信号之下（规则不该抢结论的位置），
 * 但提到了依据之前 —— 读者读完「预计 10.13」最先要问的是这个日子有多硬，而
 * 「期间任何一天都可能重置」正是那个前提；「算得准不准」才是三张依据卡回答的。
 * 极光观测台把规则收进可展开的一行，位置仍在信号之后、依据之前。窗口块复用
 * `windowBlock` —— 同一种形状（当地 + 北京两行）只该有一个渲染器，页面任何一处
 * 时间都同时给两个时区（见 PRD F2）。
 */
export function renderProgram(p) {
  if (!p || !p.window) return '';
  // 宣布时刻的**双时区**文本由数据层算好（`buildProgram` 里的 `createdZones`），
  // 渲染层只读不自算 —— 与线索块（`hintBlock`）同一口径。
  const cz = p.createdZones ?? null;
  const days =
    p.days == null
      ? ''
      : `共 <b>${esc(String(p.days))}</b> 天${
          p.daysLeft == null ? '' : ` · 还剩 <b>${esc(String(p.daysLeft))}</b> 天`
        }`;
  // 时间与原文可展开核对；链接与 summary 分开，避免一次触摸同时展开和跳走。
  return `
  <details class="sig-prog">
    <summary><span class="am-icon">${ICON.cal}</span><b>每日重置窗口</b></summary>
    <div class="am-detail">
        ${days ? `<p class="sp-left">${days}</p>` : ''}
        <p class="sp-rule">每天要么发一个改进、要么给一次完整重置 —— 期间任何一天都可能重置</p>
        ${
          cz
            ? `<p class="sp-src">发布于 ${esc(cz.a?.text ?? '')} 北京 · ${esc(
                cz.b?.text ?? ''
              )} 当地</p>`
            : ''
        }
      ${windowBlock(p.window)}
      ${p.url ? `<a class="sp-source" href="${attr(p.url)}" target="_blank" rel="noopener noreferrer">查看原文 ↗</a>` : ''}
    </div>
  </details>`;
}

export function renderSignal(sig, opts = {}) {
  if (!sig) return '';

  const blocks = [];

  // ⓪ 每日重置窗口：先讲「规则」，再讲「哪一天」。
  //    它是个**跨多日的持续事实**，与下面那条「某一天」的预告不是一回事，
  //    所以先出现；没有它时整块返回空串，页面与从前逐字节一致。
  //
  //    `inlineProgram:false` 给网页端用 —— 那边把这一块挪到**信号区之后、预测依据
  //    之前**的独立一节（模板里的 PROGRAM 占位符），同一份事实在页面上只能出现一次。
  //    默认 true 是为了保持既有调用方的行为不变（test-signals 直接 `renderSignal(sig)`）。
  const prog = opts.inlineProgram === false ? '' : renderProgram(sig.program);

  // ① 预告：**一条预告就是一个时间窗口**，支撑它的推文挂在这条里面。
  //
  //    `forecasts` 来自 signals.mjs 的 buildForecasts()，合并逻辑在数据层 ——
  //    网页、小程序、采集日志共用同一份结论，不会各算各的。
  //
  //    ⚠ 这里**不再有**「另有 N 条指向同一时间窗口的预告（先铺垫、后宣布），
  //      不重复列出」那一行。它陈述的是「我做了去重」这个实现细节，
  //      不是用户能拿走的信息；现在那几条推文直接作为这条预告的证据列出来，
  //      归属关系一眼可见（见 decisions.md 的 D-018）。
  const forecasts = sig.forecasts ?? [];
  // 倒数的初始数字要在**构建时**就算准。generatedAt 就是 detectSignals 的 now，
  // 与页面其它数字出自同一次计算，不会出现「页面上的秒数与实际差半分钟」。
  const now = Date.parse(sig.generatedAt ?? '') || Date.now();
  for (const f of forecasts) blocks.push(forecastBlock(f, sig, now));

  // ② 线索：只在没有预告时才兜底。
  //    线索是「有时间没意图」或「有意图没时间」的弱依据，跟硬信号并列会稀释前者。
  if (!forecasts.length) {
    const h = (sig.hints ?? []).find((s) => s.window) ?? null;
    if (h) blocks.push(hintBlock(h, sig, now));
  }

  if (!blocks.length) {
    // 线索数必须取 `counts.hint`（**未截断的真实条数**），不能取 `hints.length`。
    // 后者是 `slice(0, MAX_LISTED)` 之后的长度 —— 一旦留档触顶，这行就会把
    // 「260 条线索」悄悄写成「200 条线索」。这正是本仓库最忌讳的那类错：
    // 不报错、不崩溃，只让页面上的数字变小，而没人会去复核。
    const hints = sig.counts?.hint ?? (sig.hints ?? []).length;
    // 扫描窗口的**天数**取数据层的 `lookbackDays`（`detectSignals` 写入，也在
    // `data/signal.json` 里）。它回答的是「系统到底看了多长一段」——
    // 没有这个数，「一条都没检测到」和「根本没去看」在页面上长得一模一样。
    //
    // 计数取扫描总数与未截断的 counts；紧凑提示不把回看天数误说成固定数据范围。
    const extra = hints ? ` · ${hints} 条线索未形成窗口` : '';
    const sub = `${sig.checkedTweets} 条公开发言${extra}`;
    // 整条是一个**真链接**（落到最近记录）—— 右侧那个箭头若指向空处，就是假的
    // 交互提示。落点 `#records` 是模板里那个 section 的 id。
    return `${prog}
    <a class="sig-idle" href="#records">
      <span class="idle-ico" aria-hidden="true">${ICON.bell}</span>
      <span class="idle-body">
        <span class="idle-t">没有检测到重置预告</span>
        ${sub ? `<span class="idle-sub">${esc(sub)}</span>` : ''}
      </span>
      <span class="idle-go" aria-hidden="true">›</span>
    </a>`;
  }

  return prog + blocks.join('');
}

/**
 * 时间窗口块：Tibo 当地时间 + 北京时间各一行。
 *
 * 两个时区都必须给 —— 推文的时间语境在人家那边，看的人在这边。
 * 跨夏令时时差会变，所以偏移量（UTC-7 / UTC+8）也标出来。
 *
 * 行里的值由 signals.mjs 的 describeWindow 按粒度决定（具体时刻优先，
 * 区间只在整周那种含糊粒度下出现）。这里**不再自己拼时间字符串** ——
 * 曾经两处各拼一份，于是「当地 00:00 – 23:59」和「北京 15:00 → 次日 14:59」
 * 这两种凭空长出来的精度同时上了页面。
 */
function windowBlock(w) {
  if (!w) return '';
  const src = w.zones?.b;
  const usr = w.zones?.a;
  const foot = [w.zones?.diffText ?? '', w.rangeNote ?? ''].filter(Boolean).join(' · ');
  return `<div class="sig-win">
        <div class="sw">
          <span class="sw-k">Tibo 当地时间</span>
          <span class="sw-v">${esc(w.sourceZone)}</span>
          <span class="sw-z">${esc(src?.offset ?? '')}</span>
        </div>
        <div class="sw">
          <span class="sw-k">北京时间</span>
          <span class="sw-v">${esc(w.userZone)}</span>
          <span class="sw-z">${esc(usr?.offset ?? '')}</span>
        </div>
        <div class="sw-foot">${esc(foot)}</div>
      </div>`;
}

/**
 * 「距窗口开启」倒数 —— 挂在窗口块上方。
 *
 * ── 为什么要它 ──────────────────────────────────────────────────────
 * 老大原话：「距离窗口开启时间倒数应该也动起来，另外你这时间也不对啊，
 * 应该是距离北京时间的倒数。」两件事都在这一个块里解决：
 *   ① 网页端此前**根本没有**这个倒数（只有小程序有），页首那个跳动的数字是
 *      「距上一次重置」——往回看的。往前看的那个反而不会动。
 *   ② 只给一个跳动的数字、不写它数到哪一刻，读的人没法核对。所以标签里
 *      直接挂上**北京时间的锚点**（`w.openText`）：数字和时刻在同一行，
 *      对不上就是我对不上。
 *
 * 复用页首那套卷轴（`group()` / `.grp` / `.reel`）：同一种数字只该有一种动法。
 * 初始位置在构建时就写死，脚本被禁用时数字依然正确，只是不再滚动。
 */
function windowCountdown(w, now) {
  if (!w || !Number.isFinite(w.fromTs)) return '';
  const left = Math.max(0, w.fromTs - now);
  const d = Math.floor(left / DAY);
  const h = Math.floor((left % DAY) / 3_600_000);
  const mi = Math.floor((left % 3_600_000) / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  const over = left <= 0;
  return `
    <div class="sig-cd" data-from="${w.fromTs}" data-over="${over ? 1 : 0}">
      <span class="cd-cap">距窗口开启</span>
      <span class="cd-anchor">北京时间 ${esc(w.openText ?? '')}</span>
      <span class="cd-row">${group('d', String(d), '天')}${group('h', pad(h), '时')}${group(
        'm',
        pad(mi),
        '分'
      )}${group('s', pad(s), '秒')}</span>
      <span class="cd-over">窗口已开启 · 随时可能重置</span>
    </div>`;
}

/**
 * 一条预告 —— **一个单元**：时间窗口（结论）+ 支撑它的推文（依据）。
 *
 * 老大原话：「这些信息应该合并成一条预告，然后是一条预告里面 4 条推文。」
 * 在此之前同一件事被拆在横幅、计数行、折叠块三处，读的人得自己拼出
 * 「这条预告是这 4 条推文共同支撑的」。
 *
 * ── 依据默认展开，但要压得住高度 ────────────────────────────────────
 * 证据是这条预告的**可追溯性**，不是可选的复核材料 —— 藏着等于要求用户
 * 先信结论再决定要不要验，顺序反了。但页首堆砌的亏这个页面吃过（D-014），
 * 所以每条只占两行：元信息一行、原文一行（原文 clamp 到两行，看全文点原推），
 * 宽屏下两列并排。
 *
 * ── 为什么要写「未采纳的钟点线索」 ──────────────────────────────────
 * 老大的原话是「他不是都有 3am on a tuesday 这样的回复了吗，为什么没有明确时间」。
 * 那些钟点**系统一条都没漏**，只是单条看没有额度语境、不足以决定窗口。
 * 把这件事写明，用户才能区分「系统没看见」和「看见了但没采信」——
 * 前者是缺陷，后者是判断，两者的可信度完全不同。
 */
function forecastBlock(f, sig, now) {
  const t = LEVEL_TEXT[f.level] ?? LEVEL_TEXT.explicit;
  const ev = f.evidence ?? [];
  const c = f.counts ?? { hard: 0, soft: 0 };
  const unadopted = (f.clockHints ?? []).filter((x) => !x.adopted);

  const mix = [c.hard ? `<b>${c.hard}</b> 条承诺` : '', c.soft ? `<b>${c.soft}</b> 条同日提及` : '']
    .filter(Boolean)
    .join(' · ');

  const evBlock = ev.length
    ? `<details class="sig-ev" open>
      <summary class="ev-head">
        <span>依据 <b>${ev.length}</b> 条推文</span>
        ${mix ? `<span>${mix}</span>` : ''}
        ${
          unadopted.length
            ? `<span class="ev-hint">另见 ${unadopted.map((x) => esc(x.word)).join(' / ')} 钟点线索，语境与额度无关，未纳入窗口</span>`
            : ''
        }
      </summary>
      <ul class="ev-list">${ev.map(evidenceItem).join('')}</ul>
    </details>`
    : '';

  const meta = [
    f.timeNote ? `<span class="sig-note">${esc(f.timeNote)}</span>` : '',
    f.reasons?.length ? `<span>判定依据：${esc(f.reasons.join('、'))}</span>` : '',
  ].filter(Boolean);

  return `
  <section class="sig" data-level="${esc(f.level ?? 'explicit')}">
    <div class="sig-head">
      <span class="sig-badge">${t.label}</span>
      <span class="sig-title">${t.title}</span>
      ${f.precision ? `<span class="sig-precision">粒度：${esc(PRECISION_TEXT[f.precision] ?? f.precision)}</span>` : ''}
    </div>
    ${windowCountdown(f.window, now)}
    ${windowBlock(f.window)}
    ${evBlock}
    ${meta.length ? `<div class="sig-meta">${meta.join('')}</div>` : ''}
  </section>`;
}

/**
 * 证据条目：**这条预告依据的一条推文**。
 *
 * 时间一律换算到**北京时间**再显示并写明「北京」—— 旧版直接把
 * `createdAt.slice(0,16)` 的 **UTC** 贴出来，与页面其它地方（全部北京）自相矛盾，
 * 同一条推文在页面上会出现两个相差 8 小时的时间戳。
 * 「承诺 / 提及」的标签不能省：前者决定窗口，后者只是旁证，
 * 混在一起会让人以为 4 条推文的分量相等。
 */
function evidenceItem(e) {
  const weight = e.weight === 'hard' ? 'hard' : 'soft';
  const when = e.createdAt ? `${fmtDate(e.createdAt).slice(5)} ${fmtTime(e.createdAt)}` : '';
  // 「原创 / 回复」的区别必须留 —— 他大量时间线索埋在回复里，这对复核很重要。
  // 但「回复 @udiWertheimer」九个字会把这行顶到换行，连带把链接甩到下一行，
  // 看起来像另一个条目的东西。缩成「↩ @udiWertheimer」，信息没丢。
  const via = e.via && e.via !== '原创' ? `↩ ${e.via.replace(/^回复\s*/, '')}` : '原创';
  return `<li class="ev-item" data-weight="${weight}">
      <div class="ev-top">
        ${when ? `<span class="ev-when">${esc(when)} 北京</span>` : ''}
        <span class="ev-tag" data-weight="${weight}">${weight === 'hard' ? '承诺' : '提及'}</span>
        <span class="ev-via" title="原创 / 回复 —— 他大量时间线索埋在回复里">${esc(via)}</span>
        ${e.timeWord ? `<span class="ev-word" title="判定命中的时间词">${esc(e.timeWord)}</span>` : ''}
        ${e.ambiguous ? '<span class="ev-flag">待考</span>' : ''}
        ${e.url ? `<a class="ev-link" href="${esc(e.url)}" target="_blank" rel="noopener">原推 ↗</a>` : ''}
      </div>
      <p class="ev-quote">${esc(e.text ?? '')}</p>
    </li>`;
}

/**
 * 线索块：**没有预告时**才出现的弱依据兜底。
 *
 * 线索是「有时间没意图」或「有意图没时间」的单条推文，没有证据链可挂，
 * 所以形态退化成「一条推文 + 它的窗口」。窗口样式与预告块共用，
 * 但 badge 与配色走 hint 档，不会跟硬信号混淆。
 */
function hintBlock(top, sig, now) {
  const t = LEVEL_TEXT[top.level] ?? LEVEL_TEXT.hint;
  const cz = top.createdZones ?? {};

  return `
  <section class="sig" data-level="${esc(top.level ?? 'hint')}">
    <div class="sig-head">
      <span class="sig-badge">${t.label}</span>
      <span class="sig-title">${t.title}</span>
      ${top.precision ? `<span class="sig-precision">粒度：${esc(PRECISION_TEXT[top.precision] ?? top.precision)}</span>` : ''}
    </div>
    ${windowBlock(top.window)}
    <blockquote class="sig-quote">${esc(top.text)}</blockquote>
    <div class="sig-meta">
      <span>发布于 ${esc(cz.a?.text ?? dualZone(top.createdAt, CJK, sig.sourceZone, '北京时间', '当地时间').a.text)} 北京 · ${esc(cz.b?.text ?? '')} 当地</span>
      ${top.timeNote ? `<span class="sig-note">${esc(top.timeNote)}</span>` : ''}
      ${top.reasons?.length ? `<span>判定依据：${esc(top.reasons.join('、'))}</span>` : ''}
      ${top.url ? `<a href="${esc(top.url)}" target="_blank" rel="noopener">查看原推 ↗</a>` : ''}
    </div>
  </section>`;
}

/* --------------------------- 预测总览（第一层） --------------------------- */

/**
 * 「预计时间」的排版零件：`周六` / `10.10` / `13:50` 三段分开，
 * 因为它们的字重要拉开（日期最大、星期与钟点次之），合成一个串就没法分别上样式。
 */
function etaStamp(iso) {
  const p = partsIn(iso, CJK);
  return { wd: p.weekdayCN, md: `${p.month}.${p.day}`, hm: `${p.hour}:${p.minute}` };
}

/** `MM.DD HH:mm`（北京）—— 区间端点用。只到分，与页面别处的精度一致。 */
function fmtMDHM(ts) {
  const p = partsIn(new Date(ts).toISOString(), CJK);
  return `${p.month}.${p.day} ${p.hour}:${p.minute}`;
}

/**
 * 「一轮扫了多少条、一条都没采信」—— 无公告时它是**依据的一部分**，不是修饰。
 *
 * 单独抽出来是因为同一句话必须出现在**两处**：
 *   · 主卡的读屏句 `pc-brief`（见 `renderOutlook`）
 *   · 依据摘要面板的**可见**落点 `.am-basis-note`（见 `renderBasisSummary`）
 * 一处实现、两处消费 —— 否则「扫了多少条」会长出第二份实现；而它一旦只活在读屏
 * 文本里，视力可见的读者就再也分不清「系统没看见」和「看见了但不够格」。这正是
 * 2026-10-09 那次改版的教训：整句被 `am-sr-only` 藏起来，可见的依据区换成另一组
 * 数字（覆盖率 / 平均间隔），这条披露**没有承接者**、视觉上直接消失。
 * announced 档没有「扫描」可言，返回空串（由调用方决定这里不留痕）。
 */
function scanClause(o) {
  const b = o.brief;
  if (o.etaKind === 'announced' || b.scanned == null) return '';
  return `本轮扫描 ${b.scanned} 条推文${b.hints ? `，${b.hints} 条时间线索` : ''}均不足以构成预告`;
}

/**
 * 一句话依据摘要。**只用 `o.brief` 给的数字原料拼句子** ——
 * 数字同源（outlook.mjs），措辞各端自己写，因为时长口径在两端本来就不同实现。
 *
 * 这一句要回答的是「凭什么这么预测」，所以两档的字面必须真的不同：
 *   · announced → 依据是**那条公告**（可核对的承诺）
 *   · model     → 依据是**历史节奏**，并且必须把「一轮扫了多少条、一条都没采信」
 *                 说出来 —— 否则读者无法区分「系统没看见」和「看见了但不够格」。
 */
function briefLine(o) {
  const b = o.brief;
  if (o.etaKind === 'announced') {
    const bits = [];
    if (b.announcedHard) bits.push(`${b.announcedHard} 条承诺`);
    if (b.announcedSoft) bits.push(`${b.announcedSoft} 条同日提及`);
    return `Tibo 已给出公告${bits.length ? `（${bits.join(' · ')}）` : ''}，预计时间取窗口开启时刻。`;
  }
  const n = b.intervals ? `按 ${b.intervals} 次历史间隔的节奏推算` : '按历史间隔的节奏推算';
  const scan = scanClause(o);
  return `没有公告，${n}。${scan ? `${scan}。` : ''}`;
}

/* --------------------------- 卡内图标与装饰 --------------------------- */

/**
 * 三张依据卡各一个图标。
 *
 * 为什么需要：三张卡的**形状完全一致**（同样的标题行、同样的数字排布），
 * 快速滚动时唯一的区分点就是这个图标 —— 没有它，「中位剩余等待」和
 * 「样本外回测」在余光里长得一模一样。
 *
 * 一律 currentColor 描边、不写死颜色：颜色由 `.ico` 的 CSS 给，
 * 图标本身不携带颜色，否则改一次主题色要动两处。
 */
const ICON = {
  // 时钟：等待有多长
  wait: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.1" stroke="currentColor" stroke-width="1.35"/><path d="M8 4.6V8l2.4 1.6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // 柱状：拿历史回测模型
  check: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 13.2V9.9M6.7 13.2V6.4M10.4 13.2V8.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13.4 13.2V3.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".4"/></svg>',
  // 折线向下：节奏在加速
  trend: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.2 4.6 6 8.6l2.6-2.4 5.2 4.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.8 11.1h3.2V7.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // 喇叭：公告（提示条与每日重置窗口共用）
  bell: '<svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M2.6 7.1h2.1l7.1-3.5v10.8L4.7 10.9H2.6A1.2 1.2 0 0 1 1.4 9.7V8.3a1.2 1.2 0 0 1 1.2-1.2Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M5.4 11.4 6.1 14.7a1.25 1.25 0 0 0 2.45-.5l-.3-2.3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><path d="M14.3 6.4 15.6 5.4M14.4 9.6h1.6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
  // 日历：每日重置窗口
  cal: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.1" y="3.4" width="11.8" height="10.5" rx="2" stroke="currentColor" stroke-width="1.35"/><path d="M2.1 6.6h11.8M5.4 1.9v2.6M10.6 1.9v2.6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><path d="M5.6 9.6h1.6v1.6H5.6z" fill="currentColor"/></svg>',
};

/**
 * 主卡右上角的装饰：一大一小两个圆、一条弧线、一个游标点、两颗星。
 *
 * 它是这一页**唯一**的纯装饰。之所以允许它存在，是因为主卡要「明显强于其它模块」
 * 而底色只能拉一档差 —— 再往下就只能靠加边框、加角标，那是营销风的入口。
 * 装饰层 aria-hidden 且 pointer-events:none，不含信息、不挡点击。
 * 颜色是固定值而不是 CSS 变量：它要的是「比底更淡一层」，与状态色无关。
 */
const OUTLOOK_DECO = `<div class="am-orbit-field" aria-hidden="true">
  <div class="am-stage-glow"></div>
  ${[' am-outer', '', ' am-inner'].map((cls) => `<div class="am-orbit-plane${cls}"><div class="am-orbit-ring"></div><div class="am-orbit-spin"></div></div>`).join('')}
  <i class="am-star"></i><i class="am-star"></i><i class="am-star"></i><i class="am-star"></i>
</div>`;



/**
 * 预测总览（排在「已经等了多久」之后）。
 *
 * ── 为什么它要单独成层 ───────────────────────────────────────────────
 * 这一页最早是「观察站」：最先看到的是「距上次重置已经过了多久」，
 * 而用户真正要的答案是「下一次什么时候」，被压在下面。
 * 改版先把结论提到最前；2026-10-08 又调了一次顺序 —— 现在最上面是
 * 「已经等了多久」这个**事实**，紧接着的下一个就是这里。
 * 顺序的判据只有一条：**事实在前、推断在后**。
 * 这里**只在这里**给出「预计时间」这个字符串。
 *
 * ── 置信度与状态是两个轴，不能合并 ──────────────────────────────────
 * `status`（观察中 / 高概率 / 已确认）说的是**依据的来源**：
 * 有没有公告、公告说得多死。`confidence`（高 / 中 / 低）说的是
 * **这个来源值多少分**：回测样本量、区间实测覆盖率、重采样波动。
 * 公告档可以「已确认 + 置信度中」（他把话说死了，但样本本身不多）；
 * 推算档最高只能到「中」—— 没有承诺就不该有「高置信」。
 * 合并成一个标尺，就再也说不出这两件事的差别。
 *
 * 主卡与依据卡的分工也照这条线走：主卡回答「是什么」，依据卡回答「凭什么」。
 *
 * `signals` 现在不在本函数里用了（提示条由 `renderSignal` 单独渲染、紧跟在主卡
 * 之后）。签名保持不变：调用方与测试都按这个位置传参，为一个不用的形参改签名
 * 只会让下一处调用悄悄错位。
 */
export function renderOutlook(o, m, prediction, signals, collect) {
  if (!o) return '';

  const eta = etaStamp(o.etaDate);
  const over = o.etaAt - o.now <= 0;

  const left = Math.max(0, o.etaAt - o.now);
  const scale = left >= DAY ? 'd' : left >= 3_600_000 ? 'h' : left >= 60_000 ? 'm' : 's';
  const dateDigits = [...eta.md].map((ch, i) => `<span class="am-digit-cell${ch === '.' ? ' am-dot-digit' : ''}" aria-hidden="true"><span class="am-digit" style="--am-index:${i}">${ch}</span></span>`).join('');
  const band =
    o.band && Number.isFinite(o.band.fromAt) && Number.isFinite(o.band.toAt)
      ? `<div class="pc-band">
          <span><span class="k">${o.etaKind === 'announced' ? '公告窗口' : '80% 预测区间'}</span>
          <b class="am-mono">${esc(fmtMDHM(o.band.fromAt))} — ${esc(fmtMDHM(o.band.toAt))}</b></span>
          <span class="am-tiny am-muted">${o.etaKind === 'model' ? '历史推算 · 仅供参考' : esc(o.statusLabel)}</span>
        </div>`
      : '';

  return `
  <section class="pred">
    <div class="pcard" id="pred" data-status="${esc(o.status)}" data-eta="${o.etaAt}" data-over="${
      over ? 1 : 0
    }">
      <div class="pcard-top">
        <span class="am-kicker">NEXT RESET</span>
        <span class="pc-conf" data-level="${esc(o.confidence)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 7V4h3m10 0h3v3m0 10v3h-3M7 20H4v-3M5 12h14"/></svg>置信度 · ${esc(o.confidenceLabel)}</span>
      </div>
      <div class="am-stage">
        ${OUTLOOK_DECO}
        <h2>下一次重置预测</h2>
        <div class="pc-eta"><div class="am-date am-mono" aria-label="${attr(eta.md)}">${dateDigits}</div></div>
        <span class="am-small">${esc(eta.wd)} · 北京时间 · ${o.etaKind === 'model' ? '历史中位推算' : `${esc(eta.hm)} ${esc(o.etaNote)}`}</span>
        <span class="pc-badge" data-status="${esc(o.status)}">${esc(o.statusLabel)}</span>
        <div class="pc-wait" data-over="${over ? 1 : 0}">
          <span class="pc-wait-cap" id="pcd-cap">${over ? '已到预测时刻' : '预计还需等待'}</span>
          <div class="counter" id="pcd" data-scale="${scale}" role="timer" aria-label="${attr(fmtSpan(left / DAY))}">${renderEtaCounter(o)}</div>
          <span class="pc-wait-over">随时可能重置</span>
        </div>
      </div>

      ${band}

      <p class="pc-brief am-sr-only">${esc(briefLine(o))}</p>
      <div class="am-ripple-field" aria-hidden="true"></div>
    </div>
  </section>`;
}

/* --------------------------- 预测依据（第二层） --------------------------- */

/**
 * 第二层：三张依据卡 —— 「结论凭什么成立」。
 *
 * 为什么是**三张**而不是旧版的四块散文 + 两张数字块：主卡已经回答了「是什么」，
 * 这里只回答「凭什么」。凭据有三类，各自独立成立、挑着读也行：
 *   ① 剩下的等待有多长、区间多宽  ← 中位估计 + 累积概率
 *   ② 这个模型在样本外准不准      ← 覆盖率 / 区分度 / 样本量 / 重采样波动
 *   ③ 历史节奏本身在怎么变        ← 分段平均间隔
 * 三张卡共用一套骨架（图标 + 标题 → 数字/行 → 底部一句结语），于是「信息太碎」
 * 的根因被拆开：散文进主卡的一句话摘要（`.pc-brief`），卡里只放数字与判定。
 *
 * ⚠ **两支的依据不能串味。** 没有公告时凭据是上面那三项统计；有公告时凭据是
 *   **公告本身的明确程度**（他把话说死到几点，还是只给到「一周内」）。
 *   公告档下那三项统计**依然要披露**（AGENTS.md 文案红线第 3 条：覆盖率、区分度、
 *   样本量是数字不是散文，必须留），但不许再被说成结论的理由 —— 所以卡②的结语
 *   分两套：推算档讲三项达标情况，公告档明说「依据来自公告本身，与这些统计无关」。
 *
 * `signals` 在本函数里不用（扫描条数、线索数都在主卡的 `.pc-brief` 里，同一条事实
 * 只出现一次）。签名保持不变：调用方与测试都按这个位置传参，为一个不用的形参改签名
 * 只会让下一处调用悄悄错位。
 */
export function renderBasis(o, m, prediction, signals) {
  if (!o) return '';

  const cards = [
    waitCard(prediction),
    backtestCard(o, prediction),
    paceCard(prediction),
  ].filter(Boolean);

  if (!cards.length) return '';

  // `prediction.warnings` 目前恒为空数组（predict.mjs 里只声明、从不 push），所以
  // 这段现在不产出任何东西。保留它是因为另一条路更糟：哪天告警真有了产出，而这里
  // 没有落点，它就会**静默消失**。样式（`.fc-warn`）也一并留着。
  const warns = (prediction?.warnings ?? []).length
    ? `<ul class="fc-warn">${prediction.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
    : '';

  return `
  <section>
    <div class="head">
      <h2>预测依据</h2>
      <span class="hint">${
        o.etaKind === 'announced'
          ? '结论来自公告，以下是模型侧的辅助数字'
          : '结论在上方，这里是它凭什么成立'
      }</span>
    </div>
    <div class="bc-grid">${cards.join('')}</div>
    ${warns}
  </section>`;
}

/** 首屏只展示三项读数，完整概率与回测判据仍在下方展开区。 */
export function renderBasisSummary(o, prediction) {
  if (!o) return '';
  const recent = prediction?.phases?.at(-1);
  const pace = recent ? spanOf(recent.mean) : { big: '—', unit: '' };
  const coverage = prediction?.calibration?.covBand80;
  const announcedHard = o.brief.announcedHard ?? 0;
  const sourceCount = o.etaKind === 'announced' ? announcedHard || o.brief.announcedSoft || 0 : o.brief.intervals ?? 0;
  const sourceUnit = o.etaKind === 'announced' ? (announcedHard ? '条承诺' : '条同日提及') : '次间隔';
  // 依据的**边界披露**，必须是**可见**落点（`.am-basis-note`，不许加 `am-sr-only`）：
  //   · 推算档 → 「扫了多少条、一条都没采信」（`scanClause`）
  //   · 公告档 → 「依据来自公告本身」，免得读者把右下的统计读成结论的理由
  // 它与主卡的读屏句（`pc-brief`）是**同一件事的两个家**，共用 `scanClause` 那份措辞。
  const note = o.etaKind === 'announced' ? '依据来自公告本身，与这些统计无关' : scanClause(o);
  return `<section class="am-panel am-basis" aria-label="预测依据摘要">
    <h2>预测依据</h2>
    <div class="am-basis-row"><span class="am-muted">${o.etaKind === 'announced' ? '公告依据' : '历史推算'}</span><strong class="am-mono">${sourceCount}<small>${sourceUnit}</small></strong></div>
    <div class="am-basis-row"><span class="am-muted">80% 区间覆盖率</span><strong class="am-mono">${Number.isFinite(coverage) ? (coverage * 100).toFixed(1) : '—'}<small>%</small></strong></div>
    <div class="am-basis-row"><span class="am-muted">近期平均间隔</span><strong class="am-mono">${esc(pace.big)}<small>${esc(pace.unit)}</small></strong></div>
    ${note ? `<p class="am-basis-note">${esc(note)}</p>` : ''}
  </section>`;
}

/** 按三个实际显示宽度在服务端排版，浏览器只选择图形，不另算一份图表。 */
export function renderRecentRhythm(m) {
  const values = m.gapDays.slice(-7);
  const dates = m.records.slice(-values.length).map((r) => fmtDate(r.at).slice(5));
  const labels = values.map((v, i) => `${dates[i]}：${v.toFixed(2)} 天`).join('，');
  return ['wide', 'mobile', 'narrow'].map((size, i) => {
    const svg = sceneToSvgTag(rhythmScene(m, { width: [490, 310, 246][i], height: 196, fontScale: 1 }), { role: 'img', label: labels });
    return svg.replace('<svg ', `<svg class="am-trend am-trend-${size}" `)
      .replace(/id="g(\d+)"/g, `id="rhythm-${size}-$1"`)
      .replace(/url\(#g(\d+)\)/g, `url(#rhythm-${size}-$1)`);
  }).join('');
}

export function renderRecentRecords(m) {
  return m.records.slice(-3).reverse().map((r) => {
    const tag = r.url ? 'a' : 'div';
    const link = r.url ? ` href="${attr(r.url)}" target="_blank" rel="noopener noreferrer"` : '';
    return `<${tag} class="am-record"${link}><div class="am-record-top"><span class="am-mono">${fmtDate(r.at).slice(5)} ${fmtTime(r.at)}</span><span>${r.type === 'credit' ? '发券型' : '普通重置'}${r.url ? ' ↗' : ''}</span></div><p>${esc(r.text || '（无原文）')}</p></${tag}>`;
  }).join('');
}

/** 卡①：中位剩余等待 —— 多长时间、区间多宽、各个时间窗的累积概率。 */
function waitCard(prediction) {
  const p = prediction?.prediction;
  if (!p) return '';
  const q50 = spanOf(p.q50);

  const bars = (p.horizons ?? [])
    .map(
      (h) => `<div class="bc-bar">
        <span class="lb">${esc(h.label)}</span>
        <span class="track"><i style="width:${Math.max(1, h.p * 100).toFixed(1)}%"></i></span>
        <span class="pv">${pct1(h.p)}</span>
      </div>`
    )
    .join('');

  // 区间与概率都必须带**自己的口径**：「80% 区间」说的是剩余等待的双侧区间，
  // 下面那几条是「到第 N 天之前发生的累积概率」。同一张卡里两个概率概念，
  // 不写清楚就会被读成同一个。概率未经校正这句是必须留的披露 —— 它报的不是
  // 系统有多好，而是这些数字**偏低**（实际发生率通常更高）。
  const range =
    Number.isFinite(p.q10) && Number.isFinite(p.q90)
      ? `<div class="bc-range"><span class="k">80% 区间</span><b>${fmtSpan(p.q10)} – ${fmtSpan(
          p.q90
        )}</b></div>`
      : '';

  return `
  <div class="bc" data-bc="wait">
    <div class="bc-h"><span class="ico">${ICON.wait}</span><h3>中位剩余等待</h3></div>
    <div class="bc-num"><b>${esc(q50.big)}</b><small>${esc(q50.unit)}</small></div>
    ${range}
    ${bars}
    <p class="bc-note is-warn">概率未经校正 · 实际发生率通常更高</p>
  </div>`;
}

/**
 * 卡②：样本外回测 —— 这个模型在它没见过的样本上准不准。
 *
 * 四行分两类：前两行是覆盖率（模型说 80%，实测到了多少），第三行是区分度
 * （它到底比盲猜强多少 —— 实测约等于没有），第四行是重采样波动（换一批样本，
 * 这个中位数还站不站得住）。
 *
 * ⚠ **第四个数字（重采样波动）不能省。** 它与样本量、覆盖率一起**直接决定**主卡上
 *   那个置信度，而结语正是拿它们三个当主语的（「…都在容差内，置信度因此给出「中」」）。
 *   少一行，那句结语就会指着一个页面上看不见的东西说话。
 */
function backtestCard(o, prediction) {
  const cal = prediction?.calibration;
  const sk = prediction?.skill;
  const ev = o.evidence ?? {};
  const ck = o.checks ?? {};
  if (!cal || !sk) return '';

  const cov50Ok = Number.isFinite(cal.cov50) && Math.abs(cal.cov50 - 0.5) < 0.1;
  const band80 = Number.isFinite(cal.covBand80) ? pct1(cal.covBand80) : '—';
  const rel = Number.isFinite(ev.medianRel) ? ev.medianRel : null;
  const maxRel = ev.thresholds?.maxMedianRel ?? 1.5;
  const minN = ev.thresholds?.minBacktestN ?? 30;

  const row = (k, v, cls, j) => `<div class="bc-row">
        <span class="k">${esc(k)}</span>
        <span class="v${cls ? ` ${cls}` : ''}">${v}</span>
        <span class="j">${j}</span>
      </div>`;

  const skillShort =
    Math.abs(sk.score) < 0.05
      ? '≈ 无区分力'
      : sk.score > 0
        ? `优于盲猜 ${pct1(sk.score)}`
        : `略差于盲猜 ${pct1(-sk.score)}`;

  const rows = [
    row(
      '50% 分位覆盖率',
      Number.isFinite(cal.cov50) ? pct1(cal.cov50) : '—',
      cov50Ok ? 'good' : 'bad',
      cov50Ok ? '一半的中位估计落在实际值以下' : '偏离 50% 的目标'
    ),
    row(
      '80% 区间覆盖率',
      band80,
      ck.covOk ? 'good' : 'bad',
      ck.covOk ? '区间宽度合适' : '区间偏窄或偏宽'
    ),
    row(
      '7 天区分度',
      esc(skillShort),
      sk.score > 0.05 ? 'good' : 'bad',
      `Brier ${sk.brier.toFixed(3)} / 盲猜 ${sk.baseline.toFixed(3)}`
    ),
    row(
      '重采样波动',
      rel == null ? '—' : `${rel.toFixed(1)}×`,
      ck.relOk ? 'good' : 'bad',
      `换一批样本后中位估计的相对波动（阈值 ≤ ${maxRel}）`
    ),
  ].join('');

  // 结语由 `outlook.mjs` 的 `checks.note` 给出 —— 那句话的主语就是 `checks` 本身，
  // 主语只能有一个来源（见 outlook.mjs 里那段注释）。这里只负责放进卡里。
  const note = o.checks?.note ?? '';

  return `
  <div class="bc" data-bc="backtest">
    <div class="bc-h"><span class="ico">${ICON.check}</span><h3>样本外回测</h3></div>
    <div class="bc-sub">n = ${esc(String(cal.n ?? '—'))}（阈值 ≥ ${esc(String(minN))}）</div>
    ${rows}
    <p class="bc-note" data-note="backtest">${esc(note)}</p>
  </div>`;
}

/** 卡③：节奏在加速 —— 分段平均间隔。历史节奏本身在变，模型读的就是它。 */
function paceCard(prediction) {
  const phases = prediction?.phases ?? [];
  if (!phases.length) return '';

  const rows = phases
    .map((ph, i) => {
      const sp = spanOf(ph.mean);
      return `<div class="ph">
      <span class="pi">第 ${i + 1} 段</span>
      <span class="pt">${fmtDate(ph.from)} → ${fmtDate(ph.to)}</span>
      <span class="pm">${esc(sp.big)}<small>${esc(sp.unit)}</small></span>
      <span class="pn">n=${ph.n} · 最大 ${fmtSpan(ph.max)}</span>
    </div>`;
    })
    .join('');

  const first = phases[0];
  const last = phases[phases.length - 1];
  const note =
    phases.length > 1
      ? `平均间隔从 ${fmtSpan(first.mean)} 降到 ${fmtSpan(last.mean)}。`
      : '只有一段，还没有可比较的节奏变化。';

  return `
  <div class="bc" data-bc="pace">
    <div class="bc-h"><span class="ico">${ICON.trend}</span><h3>节奏在加速</h3></div>
    ${rows}
    <p class="bc-note">${esc(note)}</p>
  </div>`;
}

/* ------------------------------ 图 表 ------------------------------ */

/**
 * 三张历史图表的**草稿尺寸**：历史规律那一组是三列并排，每列在 960 容器里
 * 只剩 ~257px 的内容宽。所以三张图都按这个宽度**重新排版**（`layout:'compact'`
 * 走 `scene.js` 的紧凑预设，字号基本不缩），而不是把 900px 的图等比缩下来 ——
 * 等比缩到 257px 后 11px 的图内文字会变成 3px，等于没有文字。
 *
 * ⚠ 尺寸只有一个来源（这个常量）。图上写死的 width/height 属性与 CSS 的
 *   `width:100%` 是两件事：前者定**排版基准**（文字多少 px、标签放不放得下），
 *   后者定**显示宽度**。窄屏整列铺满时后者会把图放大，但放大是等比的，
 *   不会把标签挤丢；反过来把基准写得太大再缩小才会。
 */
const CHART_W = 260;

export function renderSurvival(m) {
  return sceneToSvgTag(survivalScene(m, { layout: 'compact', width: CHART_W }), {
    id: 'survival',
    role: 'img',
    label: '等待间隔生存曲线',
  });
}

export function renderStrip(m) {
  return sceneToSvgTag(stripScene(m, { layout: 'compact', width: CHART_W }), {
    id: 'strip',
    role: 'img',
    label: '重置间隔点阵分布',
  });
}

/**
 * 历史间隔直方图：**重置通常发生在第几天**。
 *
 * 与生存曲线、点阵图的分工：生存曲线回答「到第 X 天为止发生了多少」，
 * 点阵图回答「每次间隔各是几天」，这一张回答「哪一档最容易发生」。
 * 三张图共用同一组分桶边界（`chart-data.js` 的 HIST_BREAKS），
 * 也就是风险模型估计风险率所用的那组 —— 图与模型讨论的是同一批区间。
 */
export function renderHistogram(m) {
  return sceneToSvgTag(histogramScene(m, { layout: 'compact', width: CHART_W }), {
    id: 'hist',
    role: 'img',
    label: '历史重置间隔分布直方图',
  });
}

/**
 * 三张图共用的一行题注。高亮的是哪一根、历史中位在哪一档，都在这里说清楚。
 *
 * 它在分组之后仍然留着：三列各自只有小标题与样本量，唯独直方图那根**深色柱**
 * 与生存曲线/点阵图里的虚线要有个共同的解释。一条题注服务三张图，
 * 正是「图表缺少统一组织」的正面回答（旧版每张图各有一段引导文）。
 */
export function renderHistCaption(m) {
  const cur = m.hist?.buckets?.[m.hist?.current]?.label;
  const med = m.hist?.buckets?.[m.hist?.medianBucket]?.label;
  if (!cur) return `柱高 = 历史上落在该区间的次数。共 ${m.hist?.total ?? 0} 次历史间隔。`;
  return (
    `柱高 = 历史上落在该区间的次数，深色那根是当前等待所在的区间。` +
    `现在位于「${esc(cur)} 天」档，历史中位落在「${esc(med)} 天」档。`
  );
}

/* ------------------------------ 时间线 ------------------------------ */

export function renderTimeline(m) {
  return [...m.records]
    .reverse()
    .slice(0, 14)
    .map(
      (r) => `<li>
      <div class="when"><b>${fmtDate(r.at)}</b>${fmtTime(r.at)} 北京</div>
      <div class="body">
        <span class="tag ${r.type === 'credit' ? 'c' : 'r'}">${r.type === 'credit' ? '发券型' : '普通重置'}</span>
        <p>${esc(r.text || '（无原文）')}</p>
        ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">查看原推 ↗</a>` : ''}
      </div>
    </li>`
    )
    .join('');
}

/* ------------------------------ 分享卡片元信息 ------------------------------ */

/** 全站固定标题。og:title 与 twitter:title 保持一致，避免两边各写一套 */
export const OG_TITLE = '等 TIBO 按按钮 · 额度重置观测台';

/**
 * F8：分享元信息。
 *
 * 微信 / X / 微博展开链接时读的是这几行，**不是页面正文**。
 * 所以关键数字要同时写进 og:description —— 预览图会被平台缓存很久，
 * 文字比图更容易被重新抓取。
 *
 * SITE_URL 未配置时**不输出** og:url / og:image：宁可少两条 meta，
 * 也不给出一个指向不存在域名的绝对地址（平台抓不到会展开成空白卡）。
 */
export function renderOgMeta(og) {
  const desc =
    og?.description ??
    'Codex 额度重置观测台：距上次重置多久、还要等多久、以及 Tibo 有没有提前预告。';

  const rows = [
    ['property', 'og:type', 'website'],
    ['property', 'og:locale', 'zh_CN'],
    ['property', 'og:site_name', '额度重置观测台'],
    ['property', 'og:title', OG_TITLE],
    ['property', 'og:description', desc],
    ['name', 'twitter:card', og?.imageUrl ? 'summary_large_image' : 'summary'],
    ['name', 'twitter:title', OG_TITLE],
    ['name', 'twitter:description', desc],
  ];

  if (og?.pageUrl) rows.push(['property', 'og:url', og.pageUrl]);
  if (og?.imageUrl) {
    rows.push(['property', 'og:image', og.imageUrl]);
    rows.push(['property', 'og:image:width', '1200']);
    rows.push(['property', 'og:image:height', '630']);
    rows.push(['property', 'og:image:alt', OG_TITLE]);
    rows.push(['name', 'twitter:image', og.imageUrl]);
  }

  return rows.map(([k, key, v]) => `<meta ${k}="${key}" content="${attr(v)}" />`).join('\n');
}

/* ------------------------------ 数字摘要 ------------------------------ */

/**
 * 页面内联数字的机器可读副本（A3 一致性比对用）。
 *
 * 为什么需要它：页面是**静态渲染**（锚定在构建那一刻），后端 API 是**请求时实算**。
 * 两者只有在「同一锚点、同一份数据、同一套代码」时才可能逐字段相等。
 * 把构建锚点 `builtAt` 和它算出的数字一起写进页面，比对才有可能做到精确而不是靠容差糊过去。
 *
 * `builtAt` 与页面正文显示的「最后更新」不是一回事：后者是**数据**时间（dataUpdatedAt），
 * 前者是**渲染**时间。页面正文刻意显示数据时间 —— 用户关心的是数据多新。
 */
export function renderDigest(m, prediction, outlook) {
  const p = prediction?.prediction;
  const cal = prediction?.calibration;
  const sk = prediction?.skill;

  return JSON.stringify(
    {
      schema: 1,
      builtAt: new Date(m.now).toISOString(),
      dataUpdatedAt: m.generatedAt,
      lastResetAt: m.lastAt,
      records: m.count,
      sinceDays: (m.now - new Date(m.lastAt).getTime()) / DAY,
      coverageRatio: m.pct,
      intervals: {
        mean: m.mean,
        median: m.median,
        longest: m.longest,
        shortest: m.shortest,
      },
      // `q10` 与 `q90` 才是**双侧 80% 区间**的两个端点（0.9 − 0.1 = 0.8），
      // 而本摘要要供「页面上显示的那个区间」被逐字核对 —— 所以 `q10` 必须在。
      // 五个分位数一并给出，是因为摘要是预测的**机器可读副本**（不是「显示值清单」）；
      // 但谁都**不许**拿 `q25` 当 80% 区间的下界 —— 它只是 50% 区间的下界，
      // 实测覆盖率 68.3%，不是 80%（见 outlook.mjs 的注释）。
      // ⚠ 2026-10-09：`check-consistency.mjs` 原先正是这么比的 —— 名字写着「80% 区间」、
      // 主语却是 q25，于是真正显示的 `q10` 反而没人核对。已改为 [q10, q90]。
      remainingDays: p ? { q10: p.q10, q25: p.q25, q50: p.q50, q75: p.q75, q90: p.q90 } : null,
      horizons: p ? p.horizons.map((h) => ({ label: h.label, p: h.p })) : null,
      phases: prediction ? prediction.phases.map((x) => ({ from: x.from, to: x.to, mean: x.mean, n: x.n })) : null,
      // `cov80` 是**单侧上界** P(T ≤ q80) 的覆盖率；`covBand80` 是页面展示的那个
      // 双侧区间 [q10, q90] 自己的覆盖率。两个数说的是两件事，都要留着。
      calibration: cal ? { n: cal.n, cov50: cal.cov50, cov80: cal.cov80, covBand80: cal.covBand80 } : null,
      skill: sk ? { brier: sk.brier, baseline: sk.baseline, score: sk.score } : null,
      // 首屏那三个结论的机器可读副本。没有它们，「页面上的预计时间与 API 一致」
      // 就只能靠人去比字符串 —— 而这一项恰恰是最该被机械核对的那个。
      outlook: outlook
        ? {
            etaAt: outlook.etaAt,
            etaKind: outlook.etaKind,
            bandFromAt: outlook.band?.fromAt ?? null,
            bandToAt: outlook.band?.toAt ?? null,
            status: outlook.status,
            confidence: outlook.confidence,
          }
        : null,
    },
    null,
    2
    // 摘要嵌在 <script> 里，尖括号必须转义，否则 `</script>` 之类会提前闭合标签
  ).replace(/</g, '\\u003c');
}

/* --------------------------- 采集异常提示 --------------------------- */

/** 只接受能解析的 ISO 串；其余（undefined / 空串 / 垃圾值）一律当作「没有」 */
const isoOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

/**
 * 「数据采集异常」提示条。**没有异常时返回空串**，页面什么都不多。
 *
 * 为什么必须有它：发布链被改成「采集失败不阻断」之后（见 collect.yml），
 * 页面会在数据陈旧的情况下照常上线。不把这个状态显示出来，就等于把 CI 里的
 * 报错藏进日志 —— 正是本架构最想避免的「静默不一致」。
 *
 * 措辞刻意只承诺它确实知道的事：
 *   - 只说「本轮采集失败」，**不说**「数据是新的」
 *   - 推文数据的最后成功更新时间单列，取自 tweets.json 的 `updated_at` ——
 *     那个字段只在实时采集**成功**时才推进，是可靠的「数据新鲜度」
 *
 * ⚠ 不要拿 stats.json 的 `generated_at` 代表数据新鲜度：它每轮都刷新，
 *   采集失败时记的是**失败时刻**。用它当「最后更新」会撒谎。
 */
export function renderCollectWarning(info) {
  // 必须是数组判定，不能只写 `?? []`：stats.json 是可手改的，errors 万一是字符串
  // （旧 schema、手工编辑），`.filter` 会直接抛 TypeError，把整条构建带下去。
  // 这个函数的职责是「有异常时把异常说出来」，它自己绝不能成为那个异常。
  const errors = (Array.isArray(info?.errors) ? info.errors : []).filter(Boolean);
  if (!errors.length) return '';

  const at = isoOrNull(info?.attemptedAt);
  const live = isoOrNull(info?.lastLiveAt);

  return [
    '<div class="cwarn" role="status">',
    '  <div class="cwarn-h">',
    '    <span class="cwarn-dot"></span>',
    '    <b>数据采集异常</b>',
    at ? `    <span class="cwarn-when">本轮尝试 ${esc(fmtDateTime(at))} 北京</span>` : '',
    '  </div>',
    '  <p class="cwarn-b">本轮自动采集失败，页面数字来自仓库中已有的数据 —— 实时推文与重置信号可能滞后。' +
      (live ? `推文数据最后更新于 ${esc(fmtDateTime(live))} 北京。` : '') +
      '</p>',
    `  <ul class="cwarn-l">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`,
    '</div>',
  ]
    .filter(Boolean)
    .join('\n');
}

/* --------------------------- 数据陈旧提示 --------------------------- */

/**
 * 本机采集周期（分钟）—— 仓库里的**唯一真值来源**。
 *
 * 2026-10-02 复核 `~/.workbuddy/logs/automation.log` 的 `lastRunAt → nextRunAt`：
 * 这个值**变过一次**，此前记下的快照已过期 ——
 *
 *   09-21 22:34 ~ 09-22 08:41    6 组，间隔精确等于 2.00 小时
 *   09-22 20:05 ~ 09-30 13:49   17 组，间隔精确等于 8.00 小时
 *
 * 也就是说「声明 8 小时、实测 2 小时」那条记录只成立于 09-22 当天；此后调度与
 * rrule 一直是**一致**的（8 小时），而常量停在 120 → 阈值 240 分钟对上 480 分钟的
 * 周期，**页面有一半时间挂着「数据未更新」**。这正好复现了旧设计那条教训的形状：
 * 常亮的横幅会从告警退化成噪音。
 *
 * 2026-10-02 老大把频率定为 1 小时一次，这里随之取 60（阈值 120，见 D-035）。
 *
 * ⚠ 调整本机采集频率时**只改这一处**：陈旧阈值由它推导，不是另一个手写数字。
 * ⚠ 改完**必须重新出镜像**：阈值是请求期渲染时写进 HTML 的（`data-stale-after`），
 *   只改仓库不换镜像，线上仍是旧阈值 —— 而这一点在本地跑测试看不出来。
 */
export const LOCAL_COLLECT_INTERVAL_MINUTES = 60;

/**
 * 数据超过多久没**成功**更新，就在页面上说出来。
 *
 * 取两倍周期而不是「一倍加余量」：本机采集有调度抖动、机器休眠后补跑等情况，
 * 一倍余量会把「只是晚了一轮」也报成陈旧；两倍意味着**连续漏掉一整轮**才提示。
 *
 * 这个判据接手的是**原先 CI 每 30 分钟那轮心跳的职责**：以前「本机还在不在跑」
 * 由 CI 定时体检（它采不到，但至少能发现数据陈旧并挂横幅），现在 CI 不再采集，
 * 改由页面拿当前时间与数据时刻相减 —— 于是「发现」不再依赖任何人有空跑一次 CI。
 */
export const STALE_AFTER_MINUTES = LOCAL_COLLECT_INTERVAL_MINUTES * 2;

/**
 * 「数据未更新」提示条。
 *
 * 时间锚点取 `tweets.json` 的 `updated_at`（只在采集**成功**时推进），
 * 与 `renderCollectWarning` 同一个判据 —— 不要换成 `stats.json` 的 `generated_at`：
 * 那个采集失败时照样推进，拿它当「数据多新」会撒谎（AGENTS.md 文案红线 4）。
 *
 * 两种情况下不输出，页面保持干净：
 *   - 没有合法的 `lastLiveAt`（首次部署、数据被手改坏）
 *   - `errors` 非空 —— 那时「数据采集异常」横幅已经在说了，而且说得更具体
 *     （带着失败原因）。同一件事不铺两条相似的提示。
 *
 * 为什么容器**始终输出**（未超阈值时带 `hidden`）而不是等客户端超时再创建：
 * 模板顶部的约定是「脚本被禁用时页面依然完整」。构建那一刻就已经陈旧的话，
 * 服务端直接不给 `hidden`，静态 HTML 里也看得见。
 * 客户端只负责两件事：超阈值时去掉 `hidden`、把「距今多久」填上。
 */
export function renderFreshness(info, nowMs) {
  const errors = (Array.isArray(info?.errors) ? info.errors : []).filter(Boolean);
  if (errors.length) return '';

  const at = isoOrNull(info?.lastLiveAt);
  if (!at) return '';

  const label = fmtDateTime(at);
  const ageMs = Number(nowMs) - Date.parse(at);
  const staleNow = Number.isFinite(ageMs) && ageMs > STALE_AFTER_MINUTES * 60_000;

  return [
    `<div class="cwarn" id="cstale" role="status" data-at="${attr(at)}" data-stale-after="${STALE_AFTER_MINUTES}"${staleNow ? '' : ' hidden'}>`,
    '  <div class="cwarn-h">',
    '    <span class="cwarn-dot"></span>',
    '    <b>数据未更新</b>',
    '  </div>',
    `  <p class="cwarn-b">最近一次成功采集是 ${esc(label)} 北京<span id="cstale-age"></span>。页面数字可能已滞后。</p>`,
    '</div>',
  ].join('\n');
}

/* ------------------------------ 汇总 ------------------------------ */

export function renderAll(m, prediction, signals, opts = {}) {
  const v = renderVerdict(m);
  // 首屏那三个结论（预计时间 / 状态 / 置信度）只在一处算出来，主卡、依据区、
  // 内联摘要三方都读它 —— 否则「页面上的预计时间」会有三个各自漂移的版本。
  const outlook = buildOutlook({ chart: m, prediction, signals, now: m.now });

  // 键名统一为大写下划线，与模板里的占位符一一对应
  return {
    OG_META: renderOgMeta(opts.og),
    DIGEST: renderDigest(m, prediction, outlook),
    COLLECT_WARNING: renderCollectWarning(opts.collect),
    // 「数据未更新」条。与上面那条**互斥**：errors 非空时 renderFreshness 直接返回空串。
    // 它接手的是原先 CI 定时那轮心跳的职责（见 STALE_AFTER_MINUTES 的注释）。
    FRESHNESS: renderFreshness(opts.collect, m.now),

    // 第一层：预测结论。首屏只有它是「结论」，其余都是支撑材料。
    OUTLOOK: renderOutlook(outlook, m, prediction, signals, opts.collect),
    // 信号区（`.sig-idle` 提示条 / 预告横幅）。紧贴主卡 —— 读者看完结论的下一问
    // 就是「有没有公告」。`inlineProgram:false`：每日重置窗口由下面那个独立的
    // PROGRAM 占位符渲染，同一条事实在页面上只出现一次。
    SIGNAL: renderSignal(signals, { inlineProgram: false }),
    // 每日重置窗口：一条**规则**，排在**信号区之后、预测依据之前**。没有它时
    // renderProgram 返回空串，占位符位置什么都不留（不会出现一个空壳卡片）。
    // （键的顺序与页面顺序保持一致 —— 模板里 PROGRAM 确实在 BASIS 之前。）
    PROGRAM: renderProgram(signals?.program),
    // 第二层：预测依据（三张卡）。
    BASIS: outlook ? renderBasis(outlook, m, prediction, signals) : '',
    BASIS_SUMMARY: renderBasisSummary(outlook, prediction),
    RHYTHM: renderRecentRhythm(m),
    RECENT_RECORDS: renderRecentRecords(m),
    PREDICTED_AT: fmtMDHM(m.now),

    // 第三层：历史规律。三张图并成一组，故共用一条题注、各自带样本量。
    HISTOGRAM: renderHistogram(m),
    HIST_CAPTION: renderHistCaption(m),
    HIST_N: m.gapDays.length,
    SURVIVAL: renderSurvival(m),
    SURVIVAL_N: m.gapDays.length,
    STRIP: renderStrip(m),
    STRIP_NOW: fmtSpan(m.sinceDays),

    // 「已经等了多久」（第一块，排在预测总览之前）与更后面的样本摘要 ——
    // 都是补充材料，不是结论。
    // 页首那个数字是**四位卷轴**（与主卡倒数同一套 `.grp / .reel`）：
    // 全页最显眼的数字不会动，是改版前留下的自相矛盾。
    ELAPSED: renderElapsedCounter(m),
    LAST_AT: m.lastAt,
    LAST_LABEL: fmtDateTime(m.lastAt).slice(5),
    // 判定分档的**整块元素**（含 `v-calm/v-watch/...` 那个类）。类名由 `verdictOf`
    // 给，模板拿不到分档结果，所以这里必须把外壳一起渲染出来 —— 只给内文的话，
    // 页面上就只剩一句没有配色的裸文本（验收 A1 的「判定文案」判据会直接红）。
    VERDICT: `<div class="verdict ${v.cls}">${v.html}</div>`,
    METRICS: renderMetrics(m),

    // 末层：历史记录。`id="records"` 是提示条与「已经等了多久」右侧那个箭头的落点。
    TIMELINE: renderTimeline(m),

    // 右上角「观测中」后面跟的是**当前北京时间**，页面脚本每秒推进它。
    // 静态兜底值取**构建时刻**，不取数据采集时刻（m.generatedAt）——
    // 「观测中」是现在进行时，读者会把后面那个数字当成「现在几点」，
    // 看到两小时前的时间就以为页面停更了（这正是它上一版的问题）。
    // 「数据多新」由页脚的「最近一次采集 …」单独承担，两处不再重复同一个值。
    UPD: fmtTimeSec(new Date(m.now).toISOString()),
    GEN: fmtDateTime(m.generatedAt),
  };
}
