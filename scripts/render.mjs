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
  none: { label: '暂无信号', title: '最近没有检测到重置预告' },
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
 */
export function renderSignal(sig) {
  if (!sig) return '';

  const items = sig.level === 'explicit' ? sig.signals : sig.level === 'hint' ? sig.hints : [];
  const top = items.find((s) => s.window) ?? items[0];

  if (!top || (sig.level !== 'explicit' && !top.window)) {
    return `
    <div class="sig-idle">
      <span class="sig-dot"></span>
      <span>最近 <b>${sig.checkedTweets}</b> 条推文中没有检测到重置预告</span>
      <span class="sig-idle-sub">已扫描 ${sig.lookbackDays} 天内的公开发言</span>
    </div>`;
  }

  const t = LEVEL_TEXT[top.level] ?? LEVEL_TEXT.hint;
  const w = top.window;
  const src = w?.zones?.b;
  const usr = w?.zones?.a;

  const windowBlock = w
    ? `<div class="sig-win">
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
      </div>`
    : '';

  return `
  <section class="sig" data-level="${top.level}">
    <div class="sig-head">
      <span class="sig-badge">${t.label}</span>
      <span class="sig-title">${t.title}</span>
      ${top.precision ? `<span class="sig-precision">粒度：${PRECISION_TEXT[top.precision] ?? top.precision}</span>` : ''}
    </div>
    ${windowBlock}
    <blockquote class="sig-quote">${esc(top.text)}</blockquote>
    <div class="sig-meta">
      <span>发布于 ${esc(top.createdZones?.a?.text ?? dualZone(top.createdAt, CJK, sig.sourceZone, '北京时间', '当地时间').a.text)} 北京 · ${esc(top.createdZones?.b?.text ?? '')} 当地</span>
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

/* ------------------------------ 汇总 ------------------------------ */

export function renderAll(m, prediction, signals, opts = {}) {
  const v = renderVerdict(m);
  // 键名统一为大写下划线，与模板里的 <!--__XXX__--> 占位符一一对应
  return {
    OG_META: renderOgMeta(opts.og),
    DIGEST: renderDigest(m, prediction),
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
