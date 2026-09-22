/**
 * 构建时渲染：把所有内容（图表 SVG、指标、时间线、判定、信号）在 Node 里算好，
 * 产出纯静态 HTML 片段。
 *
 * 为什么不放在浏览器里跑？
 *  - 不依赖 JS 运行环境，脚本被限制的 WebView 也能正常显示
 *  - 内联 SVG 一律带 width/height 属性，避免靠 height:auto 撑高时塌成 0
 *  - 页面加载即出图，没有白屏闪烁
 *
 * ⚠ 所有面向用户的时间一律按 **Asia/Shanghai** 渲染。
 *   曾经用本地时区，结果部署到 GitHub Actions（runner 是 UTC）后页面上全是 UTC 时间。
 */

import { fmtDateIn, fmtDateTimeIn, partsIn, dualZone } from '../src/lib/chart-data.js';
import { survivalScene, stripScene } from '../src/lib/scene.js';
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
const fmtDateTime = (iso) => fmtDateTimeIn(iso, CJK);

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 属性值转义：比正文多一个双引号，否则 meta content 会被提前闭合 */
const attr = (s) => esc(s).replace(/"/g, '&quot;');

const pct1 = (x) => (x * 100).toFixed(1) + '%';

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
  `<span class="grp" data-g="${key}"><span class="reels">${reels(str)}</span><span class="unit">${unit}</span></span>`;

export function renderCounter(m) {
  const ms = m.now - new Date(m.lastAt).getTime();
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / 3_600_000);
  const mi = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return (
    group('d', String(d), '天') +
    group('h', pad(h), '时') +
    group('m', pad(mi), '分') +
    group('s', pad(s), '秒')
  );
}

export function renderSince(m) {
  const ms = m.now - new Date(m.lastAt).getTime();
  const d = Math.floor(ms / DAY);
  return `上次重置 ${fmtDateTime(m.lastAt)} · 已过 ${d < 1 ? '不足一天' : d + ' 天'}`;
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

export function renderMetrics(m) {
  const items = [
    { k: '平均间隔', v: m.mean.toFixed(1), u: '天', note: '被极端值拉高' },
    { k: '中位间隔', v: m.median.toFixed(1), u: '天', note: '一半情况比这更快', hi: true },
    { k: '最长等待', v: m.longest.toFixed(1), u: '天', note: '极端长尾' },
    { k: '记录总数', v: m.count, note: `${fmtDate(m.firstAt)} 起` },
    { k: '普通重置', v: m.count - m.creditCount, note: '额度直给' },
    { k: '发券型', v: m.creditCount, note: '改成给券' },
  ];
  return items
    .map(
      (it) => `<div class="metric${it.hi ? ' hi' : ''}">
    <div class="k">${it.k}</div>
    <div class="v">${it.v}${it.u ? `<small>${it.u}</small>` : ''}</div>
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
export function renderSignal(sig) {
  if (!sig) return '';

  const blocks = [];

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
  for (const f of forecasts) blocks.push(forecastBlock(f, sig));

  // ② 线索：只在没有预告时才兜底。
  //    线索是「有时间没意图」或「有意图没时间」的弱依据，跟硬信号并列会稀释前者。
  if (!forecasts.length) {
    const h = (sig.hints ?? []).find((s) => s.window) ?? null;
    if (h) blocks.push(hintBlock(h, sig));
  }

  if (!blocks.length) {
    const hints = (sig.hints ?? []).length;
    const extra = hints ? `，${hints} 条线索` : '';
    return `
    <div class="sig-idle">
      <span class="sig-dot"></span>
      <span>时间窗内 <b>${sig.checkedTweets}</b> 条推文中没有检测到重置预告${extra}</span>
      <span class="sig-idle-sub">时间窗自 ${esc(String(sig.windowFrom ?? '').slice(0, 10))} 起 · 共扫 ${sig.checkedTweets} 条</span>
    </div>`;
  }

  // 因体积上限被截断时要说出来 —— 静默截断正是这次修掉的那类问题。
  if (sig.truncated) {
    blocks.push(
      `<div class="sig-idle"><span class="sig-dot"></span><span>线索/排除项超出留档上限，signal.json 中只保留了前 ${sig.hints?.length ?? 0} / ${sig.rejected?.length ?? 0} 条</span></div>`
    );
  }

  return blocks.join('');
}

/**
 * 时间窗口块：Tibo 当地时间 + 北京时间各一行。
 *
 * 两个时区都必须给 —— 推文的时间语境在人家那边，看的人在这边。
 * 跨夏令时时差会变，所以偏移量（UTC-7 / UTC+8）也标出来。
 */
function windowBlock(w) {
  if (!w) return '';
  const src = w.zones?.b;
  const usr = w.zones?.a;
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
        <div class="sw-foot">
          ${esc(w.zones?.diffText ?? '')}${w.crossesUserDay ? ' · 换算到北京时间后会跨自然日' : ''}
        </div>
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
function forecastBlock(f, sig) {
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
function hintBlock(top, sig) {
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

/* ------------------------------ 图 表 ------------------------------ */

export function renderSurvival(m) {
  return sceneToSvgTag(survivalScene(m), {
    id: 'survival',
    role: 'img',
    label: '等待间隔生存曲线',
  });
}

export function renderStrip(m) {
  return sceneToSvgTag(stripScene(m), {
    id: 'strip',
    role: 'img',
    label: '重置间隔点阵分布',
  });
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

/* ------------------------------ 时间预测 ------------------------------ */

/**
 * 预测区块。
 *
 * 只输出数字与单位，不写「本模型不预测什么」这类关于模型自身的说明。
 * 但**数据类披露必须留**：覆盖率、区分度、样本量 —— 那是数字，不是散文。
 */
export function renderForecast(pred) {
  if (!pred) {
    return `<div class="card"><p class="fc-empty">历史样本不足，暂不输出预测。</p></div>`;
  }

  const p = pred.prediction;
  const cal = pred.calibration;
  const hours = Math.round(p.q50 * 24);

  const bars = p.horizons
    .map(
      (h) => `<div class="fc-bar">
      <span class="lb">${h.label}</span>
      <span class="track"><i style="width:${Math.max(1, h.p * 100).toFixed(1)}%"></i></span>
      <span class="pv">${pct1(h.p)}</span>
    </div>`
    )
    .join('');

  const phaseRows = pred.phases
    .map(
      (ph, i) => `<div class="ph">
      <span class="pi">第 ${i + 1} 段</span>
      <span class="pt">${fmtDate(ph.from)} → ${fmtDate(ph.to)}</span>
      <span class="pm">${ph.mean.toFixed(2)}<small>天</small></span>
      <span class="pn">n=${ph.n} · 最大 ${ph.max.toFixed(0)} 天</span>
    </div>`
    )
    .join('');

  const sk = pred.skill.score;
  const nearZero = Math.abs(sk) < 0.05;
  const skillShort = nearZero
    ? '≈ 无区分力'
    : sk > 0
      ? `优于盲猜 ${(sk * 100).toFixed(1)}%`
      : `略差于盲猜 ${(sk * 100).toFixed(1)}%`;

  const warnHtml = pred.warnings.length
    ? `<ul class="fc-warn">${pred.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
    : '';

  return `
    <p class="fc-asof">
      计算于 <b>${fmtDateTime(pred.asOf)}</b> 北京时间（距上次重置 ${pred.sinceDays.toFixed(2)} 天）
    </p>

    <div class="fc">
      <div class="fc-main">
        <div class="k">中位剩余等待</div>
        <div class="v">${p.q50.toFixed(1)}<small>天</small></div>
        <div class="range">
          ${hours >= 1 ? `约 ${hours} 小时 · ` : ''}80% 区间 <b>${p.q25.toFixed(1)} – ${p.q90.toFixed(1)}</b> 天
        </div>
      </div>
      <div class="fc-bars">
        ${bars}
        <p class="fc-note">概率<strong>未校准</strong>，实际发生率通常比上面显示的高。</p>
      </div>
    </div>

    <div class="fc-meta">
      <div class="fc-block">
        <h3>样本外回测（n=${cal.n}）</h3>
        <table class="fc-table">
          <tr><th>指标</th><th>实测</th><th>判定</th></tr>
          <tr>
            <td>50% 分位覆盖率</td>
            <td class="num ${Math.abs(cal.cov50 - 0.5) < 0.1 ? 'good' : 'bad'}">${pct1(cal.cov50)}</td>
            <td>${Math.abs(cal.cov50 - 0.5) < 0.1 ? '校准良好' : '偏离目标'}</td>
          </tr>
          <tr>
            <td>80% 分位覆盖率</td>
            <td class="num ${Math.abs(cal.cov80 - 0.8) < 0.1 ? 'good' : 'bad'}">${pct1(cal.cov80)}</td>
            <td>${Math.abs(cal.cov80 - 0.8) < 0.1 ? '校准良好' : '区间偏宽'}</td>
          </tr>
          <tr>
            <td>7 天区分度</td>
            <td class="num bad">${skillShort}</td>
            <td>Brier ${pred.skill.brier.toFixed(3)} / 盲猜 ${pred.skill.baseline.toFixed(3)}</td>
          </tr>
        </table>
      </div>

      <div class="fc-block">
        <h3>节奏在加速</h3>
        ${phaseRows}
        <p class="fc-foot">
          平均间隔从 ${pred.phases[0].mean.toFixed(1)} 天降到 ${pred.phases[pred.phases.length - 1].mean.toFixed(1)} 天。
        </p>
      </div>
    </div>
    ${warnHtml}
  `;
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
export function renderDigest(m, prediction) {
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
      remainingDays: p ? { q25: p.q25, q50: p.q50, q90: p.q90 } : null,
      horizons: p ? p.horizons.map((h) => ({ label: h.label, p: h.p })) : null,
      phases: prediction ? prediction.phases.map((x) => ({ from: x.from, to: x.to, mean: x.mean, n: x.n })) : null,
      calibration: cal ? { n: cal.n, cov50: cal.cov50, cov80: cal.cov80 } : null,
      skill: sk ? { brier: sk.brier, baseline: sk.baseline, score: sk.score } : null,
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

/* ------------------------------ 汇总 ------------------------------ */

export function renderAll(m, prediction, signals, opts = {}) {
  const v = renderVerdict(m);
  // 键名统一为大写下划线，与模板里的 <!--__XXX__--> 占位符一一对应
  return {
    OG_META: renderOgMeta(opts.og),
    DIGEST: renderDigest(m, prediction),
    COLLECT_WARNING: renderCollectWarning(opts.collect),
    SIGNAL: renderSignal(signals),
    COUNTER: renderCounter(m),
    SINCE: renderSince(m),
    VERDICT: `<div class="verdict ${v.cls}">${v.html}</div>`,
    METRICS: renderMetrics(m),
    FORECAST: renderForecast(prediction),
    SURVIVAL: renderSurvival(m),
    SURVIVAL_N: m.gapDays.length,
    STRIP: renderStrip(m),
    TIMELINE: renderTimeline(m),
    UPD: fmtTime(m.generatedAt),
    GEN: fmtDateTime(m.generatedAt),
    LAST_AT: m.lastAt,
    LAST_LABEL: fmtDateTime(m.lastAt),
  };
}
