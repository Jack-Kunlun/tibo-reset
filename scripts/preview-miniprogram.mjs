#!/usr/bin/env node
/**
 * 小程序布局预览（开发工具，不参与发布）。
 *
 * 为什么需要它：微信开发者工具的自动化需要开启「服务端口」，那是安全设置，
 * 不该由脚本替用户打开。而小程序的视觉恰恰是风险最高的一环 ——
 * 之前出过「图表一片空白」，那种问题只有真的看一眼才能发现。
 *
 * 做法：把 **真实的 WXSS** 和 **真实的图元渲染器（utils/draw.js）** 搬到一个
 * 手机宽度的网页里跑一遍。CSS 与绘图代码都是同一份，只有外壳是 HTML。
 * rpx 按 375px 视口换算（750rpx = 375px，即 1rpx = 0.5px）。
 *
 * ⚠ 这不是小程序运行时，不能替代真机验证。它的作用是在上传之前，
 *   用最低成本发现「布局崩了 / 图画到画布外 / 字号小到看不见」这类问题。
 *
 * 用法：npm run preview:mp  → 用任意静态服务器打开 dist/miniprogram-preview.html
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChartData } from '../src/lib/chart-data.js';
import { predictAll } from '../src/lib/predict.mjs';
import { detectSignals, latestEventMs } from '../src/lib/signals.mjs';
import { elapsed, fmtSpan, reelGroups, fmtDateTime, fmtClockSec, verdict as makeVerdict } from '../miniprogram/utils/format.js';
import { buildGauge, buildSignal, buildMetrics, buildForecast, buildOutlookView, predCountdown } from '../miniprogram/utils/view.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = async (p) => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'));

/* ---------------------------- rpx → px ---------------------------- */

const RPX = 0.5; // 375px 视口下 1rpx = 0.5px
const wxssToCss = (s) =>
  s.replace(/([\d.]+)rpx/g, (_, n) => `${Math.round(Number(n) * RPX * 100) / 100}px`);

/* ------------------------------ 数据 ------------------------------ */

const [resets, tweets] = await Promise.all([read('data/resets.json'), read('data/tweets.json')]);
const now = Date.now();

// --demo-signal：注入一条合成推文，把「有预告」这条路径点亮。
// 真实数据里可能长期没有预告，而信号横幅恰恰是全页视觉重量最大的地方 ——
// 不点亮一次，改了样式也没人看得见，回归时更会忘了它还存不存在。
const DEMO_SIGNAL = process.argv.includes('--demo-signal');
const DEMO_TWEET = {
  id: 'demo-signal',
  text: 'We will reset all usage limits next Tuesday.',
  created_at: new Date(now - 5 * 3600_000).toISOString(),
  kind: 'other',
  account: 'thsottiaux',
};
const tweetPool = DEMO_SIGNAL ? [DEMO_TWEET, ...tweets.tweets] : tweets.tweets;

const chart = buildChartData(resets.records, now);
const prediction = predictAll(resets.records, { now });
// ⚠ `lastResetAt` 不能省。它不只是给「窗口已过去」用的 —— 少了它，
// `staleWindowReason` 里 `fulfilled`（窗口内已发生过重置）这一支永不触发，
// 于是**已兑现的预告会被当成仍然有效的预告**显示出来。
// 三条生产路径（page.mjs / collect.mjs / server）都传了，只有这里漏了 ——
// 后果不是线上出错，而是本地预览显示的状态与真实状态不一致，
// 而它的定位恰恰是「上传前用最低成本发现问题」。口径必须与 page.mjs 完全一致。
const signals = detectSignals(tweetPool, {
  now,
  account: 'thsottiaux',
  lastResetAt: latestEventMs(resets.records),
});

const lastAt = new Date(chart.lastAt).getTime();
const counter = reelGroups(elapsed(lastAt));
const v = makeVerdict(chart.pct);
const metrics = buildMetrics(chart);
const gauge = buildGauge(chart);
const sig = buildSignal(signals);
// 预测总览的锚点取**预测自己的 asOf**，与 pages/index/index.js 的 apply() 同一口径。
// 用 Date.now() 会得到一个和页面上「预测算于 X」对不上的 ETA。
const predNow = Date.parse(prediction.asOf) || now;
const pred = buildOutlookView(chart, prediction, signals, predNow);
// ⚠ 依据卡要读 outlook 的判据（`checks`），所以必须先有 `pred` 才能算 `forecast`。
//   反过来的顺序（先 forecast 再 pred）会让卡②底部那句结语落空 —— 这在页面上
//   只表现为「少了一句总结」，不报错、不塌版，正是最难发现的那类不一致。
const forecast = buildForecast(prediction, pred);
// 倒计时文案走共享函数（页面每秒 tick 用的是同一个）—— 预览里各写一份，
// 那句措辞就会与真机不一致，「预览通过」随即变成没有根据的话。
const predCd = predCountdown(pred, now);

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/* ------------------------------ 片段 ------------------------------ */

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

const counterHtml = counter
  .map(
    (g) => `<div class="grp"><div class="reels">${g.digits
      .map(
        (d) =>
          `<div class="reel"><div class="strip" style="transform:translateY(-${d}em)">${DIGITS.map(
            (n) => `<div class="dg">${n}</div>`
          ).join('')}</div></div>`
      )
      .join('')}</div><span class="unit">${g.unit}</span></div>`
  )
  .join('');

/* 预测总览的倒计时用**自己的类名**（pcd-），不复用信号区那套 .cd-* ——
   两块的字号差一倍（主数字 vs 注脚），共用一套类名就得靠后人记得别覆盖。
   信号区那个「距窗口开启」的倒数已随「与主卡同锚点、同值」一并去掉。 */
const pcdHtml = (groups) =>
  groups
    .map(
      (g) => `<div class="pcd-g"><span class="pcd-v">${esc(g.v)}</span><span class="pcd-u">${esc(g.unit)}</span></div>`
    )
    .join('');

/* 第二层：预测总览（上面那块是「已经等了多久」）。结构照 index.wxml 那块逐句对齐 ——
   预览是手写副本，不对齐就会给出一个真机上不存在的页面（这块正是新加的，漏了就会被
   当成「本来就这样」）。 */
const predHtml = pred
  ? `<div class="pred" data-status="${esc(pred.status)}" data-level="${esc(pred.confidence)}">
      <div class="pred-head">
        <span class="pred-t">下一次重置预测</span>
        <span class="pred-badge">${esc(pred.statusLabel)}</span>
      </div>
      <div class="pred-note">${esc(pred.statusNote)} · ${esc(pred.etaNote)}</div>
      <div class="pred-eta">
        <span class="pe-md">${esc(pred.md)}</span>
        <span class="pe-rest">${esc(pred.wd)} ${esc(pred.hm)}</span>
      </div>
      <div class="pred-cd${predCd && predCd.over ? ' is-over' : ''}">
        <span class="pcd-cap">${esc(predCd ? predCd.label : '')}</span>
        <div class="pcd-row" id="pcd" data-eta="${pred.etaAt}" data-kind="${esc(pred.etaKind)}">${pcdHtml(
          predCd ? predCd.groups : []
        )}</div>
        ${
          pred.band
            ? `<div class="pred-band"><span class="pb-k">${esc(pred.bandLabel)}</span><span class="pb-v">${esc(pred.band)}</span></div>`
            : ''
        }
      </div>
      <div class="pred-brief">${esc(pred.brief)}</div>
      <div class="pred-foot">
        <span class="pf-k">置信度</span>
        <span class="pf-v">${esc(pred.confidenceLabel)}</span>
        <div class="pf-bar"><div class="pf-fill" style="width:${pred.confidenceW}%"></div></div>
        <span class="pf-upd">预测算于 ${esc(pred.updatedText)}</span>
      </div>
    </div>`
  : '';

/* 每日重置窗口：**不在** sig.show 那道门里，所以它是独立的一块。
   结构照 index.wxml 的那块逐句对齐 —— 预览是手写副本，不对齐就会给出一个真机上
   不存在的页面。

   ⚠ 位置：`.hero` → `.pred` → `.sig`/`.sig-idle` → **它** → `.bc-grid`（预测依据）。
   旧版它在全页最前，于是首屏第一眼读到的是「规则」而不是「下一次什么时候」；
   2026-10-08 中途挪到「预测依据之后」，2026-10-09 老大要求「放在预测下方」，
   于是提到信号区之后、依据之前。 */
const progHtml = sig.program?.show
  ? `<div class="prog">
      <div class="prog-head">
        <div class="ico ico-cal"></div>
        <span class="prog-tag">每日重置窗口</span>
        <span class="prog-left">共 <span class="n">${esc(sig.program.days)}</span> 天 · 还剩 <span class="n">${esc(sig.program.daysLeft)}</span> 天</span>
      </div>
      <span class="prog-rule">每天要么发一个改进、要么给一次完整重置 —— 期间任何一天都可能重置</span>
      ${
        sig.program.window
          ? `<div class="win">
              <div class="wrow"><span class="k">Tibo 当地时间</span><span class="v">${esc(sig.program.window.sourceZone)}</span><span class="z">${esc(sig.program.window.srcOffset)}</span></div>
              <div class="wrow"><span class="k">北京时间</span><span class="v">${esc(sig.program.window.userZone)}</span><span class="z">${esc(sig.program.window.usrOffset)}</span></div>
              <div class="wfoot">${esc(sig.program.window.diffText)}${sig.program.window.rangeNote ? ` · ${esc(sig.program.window.rangeNote)}` : ''}</div>
            </div>`
          : ''
      }
      <div class="prog-meta">
        ${sig.program.announcedText ? `<span>发布于 ${esc(sig.program.announcedText)}</span>` : ''}
        ${sig.program.url ? `<span class="prog-link">复制原推链接</span>` : ''}
      </div>
    </div>`
  : '';

const signalHtml = sig.show
  ? `<div class="sig" data-level="${sig.level}">
      <div class="sig-halo"></div>
      <div class="sig-head">
        <span class="badge"><span class="bdot"></span>${esc(sig.badge)}</span>
        <span class="sig-title">${esc(sig.title)}</span>
      </div>
      ${
        sig.headline
          ? `<div class="ann">
              <span class="ann-cap">预告时间</span>
              <span class="ann-big">${esc(sig.headline.big)}</span>
              <span class="ann-sub">${esc(sig.headline.sub)}</span>
            </div>`
          : ''
      }
      ${
        sig.window
          ? `<div class="win">
              <div class="wrow"><span class="k">Tibo 当地时间</span><span class="v">${esc(sig.window.sourceZone)}</span><span class="z">${esc(sig.window.srcOffset)}</span></div>
              <div class="wrow"><span class="k">北京时间</span><span class="v">${esc(sig.window.userZone)}</span><span class="z">${esc(sig.window.usrOffset)}</span></div>
              <div class="wfoot">${esc(sig.window.diffText)}${sig.window.rangeNote ? ` · ${esc(sig.window.rangeNote)}` : ''}</div>
              ${sig.precision ? `<span class="wprec">粒度：${esc(sig.precision)}</span>` : ''}
            </div>`
          : ''
      }
      ${
        sig.evCount
          ? `<details class="ev" open>
              <summary class="ev-head">
                <span class="ev-t">依据 ${sig.evCount} 条推文</span>
                ${sig.evMix ? `<span class="ev-mix">${esc(sig.evMix)}</span>` : ''}
                <span class="ev-toggle">收起/展开</span>
              </summary>
              <div class="ev-body">
                ${sig.evNote ? `<div class="ev-note">${esc(sig.evNote)}</div>` : ''}
                ${sig.ev
                  .map(
                    (e) => `<div class="ev-item ${e.weight}">
                  <div class="ev-top">
                    <span class="ev-when">${esc(e.when)} 北京</span>
                    <span class="ev-tag ${e.weight}">${esc(e.tag)}</span>
                    ${e.via ? `<span class="ev-via">${esc(e.via)}</span>` : ''}
                    ${e.word ? `<span class="ev-word">${esc(e.word)}</span>` : ''}
                  </div>
                  <div class="ev-quote">${esc(e.text)}</div>
                </div>`
                  )
                  .join('')}
              </div>
            </details>`
          : `<div class="quote">${esc(sig.text)}</div>`
      }
      <div class="meta">
        ${sig.createdText ? `<span>发布于 ${esc(sig.createdText)}</span>` : ''}
        ${sig.timeNote ? `<span class="note">${esc(sig.timeNote)}</span>` : ''}
        ${sig.reason ? `<span>判定依据：${esc(sig.reason)}</span>` : ''}
      </div>
    </div>`
  : `<div class="sig-idle">
      <div class="idle-ico"></div>
      <div class="idle-body">
        <div class="idle-t">最近 <b>${sig.checked}</b> 条推文中没有检测到重置预告</div>
        ${sig.windowFrom ? `<div class="idle-sub">时间窗自 ${esc(sig.windowFrom)} 起</div>` : ''}
      </div>
      <span class="idle-go">›</span>
    </div>`;

const metricsHtml = metrics
  .map(
    (m) => `<div class="metric"><div class="k">${esc(m.k)}</div><div class="v ${m.hi ? 'hl' : ''}">${esc(
      m.v
    )}${m.u ? `<span class="u">${esc(m.u)}</span>` : ''}</div><div class="note">${esc(m.note)}</div></div>`
  )
  .join('');

/* 预测依据：三张卡，各自独立成立。
   ⚠ 这份 HTML 是**手写副本**，不是从 index.wxml 渲染出来的 —— 结构必须逐块对齐，
   否则「预览通过」是一句没有根据的话（样式会自动跟随：wxss 是读原文件转的，
   只有结构要手写）。判据用**带属性**的串（`class="bc-grid"` 这类），
   只 grep `bc` 会命中 <style> 里的选择器、看起来「渲染好了」其实没有。 */
const forecastHtml = forecast
  ? `<div class="bc-grid">

      <div class="bc" data-bc="wait">
        <div class="bc-h"><div class="ico ico-wait"></div><span class="bc-t">中位剩余等待</span></div>
        <div class="bc-num"><span class="b">${forecast.wait.num}</span><span class="u">${esc(
          forecast.wait.unit
        )}</span></div>
        <div class="bc-range">${esc(forecast.wait.range)}</div>
        ${forecast.wait.bars
          .map(
            (b) =>
              `<div class="bc-bar"><span class="lb">${esc(b.label)}</span><div class="track"><div class="fill" style="width:${b.w}%"></div></div><span class="pv">${esc(
                b.pv
              )}</span></div>`
          )
          .join('')}
        <div class="bc-note is-warn">${esc(forecast.wait.warn)}</div>
      </div>

      <div class="bc" data-bc="backtest">
        <div class="bc-h"><div class="ico ico-bars"></div><span class="bc-t">样本外回测</span></div>
        <div class="bc-sub">n = ${forecast.backtest.n}（阈值 ≥ ${forecast.backtest.minN}）</div>
        ${forecast.backtest.rows
          .map(
            (r) =>
              `<div class="bc-row"><span class="k">${esc(r.k)}</span><span class="v ${
                r.ok ? 'good' : 'bad'
              }">${esc(r.v)}</span><span class="j">${esc(r.j)}</span></div>`
          )
          .join('')}
        <div class="bc-note" data-note="backtest">${esc(forecast.backtest.note)}</div>
      </div>

      <div class="bc" data-bc="pace">
        <div class="bc-h"><div class="ico ico-trend"></div><span class="bc-t">节奏在加速</span></div>
        ${forecast.pace.phases
          .map(
            (p) =>
              `<div class="ph"><span class="pi">第 ${p.i} 段</span><span class="pt">${esc(p.from)} → ${esc(
                p.to
              )}</span><span class="pm">${p.mean}<span class="u">${esc(p.unit)}</span></span><span class="pn">n=${
                p.n
              } · 最大 ${esc(p.max)}</span></div>`
          )
          .join('')}
        <div class="bc-note">${esc(forecast.pace.note)}</div>
      </div>

    </div>`
  : '';

/* ------------------------------ 组装 ------------------------------ */

const appWxss = wxssToCss(await readFile(resolve(ROOT, 'miniprogram/app.wxss'), 'utf8'));
const pageWxss = wxssToCss(await readFile(resolve(ROOT, 'miniprogram/pages/index/index.wxss'), 'utf8'));

// 只把 WXML 的 view/text 换成 div/span 需要的最小归一化，其余样式原样使用
const normalize = `
  /* 预览专用：WXML 的 view 默认 block、text 默认 inline，这里显式声明 */
  .reel .dg{display:block}
  .strip{display:block}
  body{margin:0;background:#8C8880;padding:24px 0}
  .phone{width:375px;margin:0 auto;background:#FAF8F4;min-height:1200px;box-shadow:0 8px 40px rgba(0,0,0,.28)}
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>小程序布局预览 · 等 TIBO 按按钮</title>
<style>
${appWxss}
${pageWxss}
${normalize}
</style>
</head>
<body>
<div class="phone">
<div class="wrap">

  <div class="top">
    <div class="brand"><span class="h1">等 TIBO 按按钮</span><span class="sub">RESET OBSERVATORY</span></div>
    <div class="pulse"><span class="dot"></span><span>观测中 · <span id="upd">${esc(fmtClockSec(now))}</span></span></div>
  </div>

  <div class="sec-head"><span class="t">已经等了多久</span></div>

  <div class="hero">
    <div class="label">距上一次额度重置</div>
    <div class="counter">${counterHtml}</div>
    <div class="since">上次重置 ${esc(fmtDateTime(lastAt))} · 已过 ${fmtSpan(elapsed(lastAt).ms / 86400000)}</div>
    <div class="verdict v-${v.cls}"><span class="b">${esc(v.text)}</span><span class="sep"> · </span><span>${esc(
      v.tail
    )}</span></div>
    ${
      gauge
        ? `<div class="gauge g-${gauge.cls}">
            <div class="g-track"><div class="g-fill" style="width:${gauge.fill}%"></div></div>
            <div class="g-text">${esc(gauge.text)}</div>
          </div>`
        : ''
    }
  </div>

  ${predHtml}

  ${signalHtml}

  ${progHtml}

  <div class="sec-head"><span class="t">预测依据</span><span class="h">${esc(
    forecast ? forecast.hint : ''
  )}</span></div>
  ${forecastHtml}

  <div class="sec-head"><span class="t">历史规律</span><span class="h">n = ${chart.gapDays.length} 次历史间隔</span></div>
  <div class="lede">三张图看的是同一批历史间隔：哪一档最容易发生、到第 X 天为止发生了多少、每次各是几天。</div>
  <div class="lede lede-2">直方图横轴按区间等宽分档（不是按天数），纵轴是落在该档的次数；高亮那一档就是你当前所在的一档。</div>

  <div class="hr-grid">
    <div class="hr">
      <div class="hr-h"><span class="hr-t">重置通常发生在第几天</span><span class="hr-n">n = ${chart.gapDays.length}</span></div>
      <canvas id="hist" class="chart chart-hist"></canvas>
    </div>

    <div class="hr">
      <div class="hr-h"><span class="hr-t">等待生存曲线</span><span class="hr-n">n = ${chart.gapDays.length}</span></div>
      <canvas id="survival" class="chart chart-survival"></canvas>
    </div>

    <div class="hr">
      <div class="hr-h"><span class="hr-t">每次间隔的离散分布</span><span class="hr-n">n = ${chart.gapDays.length}</span></div>
      <canvas id="strip" class="chart chart-strip"></canvas>
      <div class="legend">
        <div class="lg"><span class="sw sw-lan"></span>常规间隔</div>
        <div class="lg"><span class="sw sw-mist"></span>偏长间隔</div>
        <div class="lg"><span class="sw sw-cin"></span>极端长等待</div>
      </div>
    </div>
  </div>

  <div class="sec-head"><span class="t">样本摘要</span></div>

  <div class="metrics">${metricsHtml}</div>

  <div class="foot">
    <div>数据：公开推文记录 · 最近一次采集 ${esc(fmtDateTime(now))} 北京</div>
    <div>观测账号 x.com/thsottiaux</div>
  </div>

</div>
</div>

<script type="application/json" id="chart-data">${JSON.stringify(chart)}</script>
<script type="module">
  // 关键：这里 import 的是**发布用的同一份**几何与绘制代码，不是复制品
  import { survivalScene, stripScene, histogramScene, sceneBounds } from '../src/lib/scene.js';
  import { drawScene } from '../miniprogram/utils/draw.js';
  import { predCountdown } from '../miniprogram/utils/view.js';

  const chart = JSON.parse(document.getElementById('chart-data').textContent);
  const dpr = window.devicePixelRatio || 2;

  function paint(sel, make, heightCss) {
    const cv = document.querySelector(sel);
    if (!cv) return;
    const w = Math.round(cv.getBoundingClientRect().width);
    const h = Math.round(heightCss);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const scene = make(chart, { layout: 'compact', width: w, height: h });
    drawScene(ctx, scene, dpr);

    // 越界自检：画到画布外就是「图看起来是空的」的常见原因
    const b = sceneBounds(scene);
    const bad = b.minX < -0.5 || b.maxX > w + 0.5 || b.minY < -0.5 || b.maxY > h + 0.5;
    document.title = (bad ? '✗ 越界 ' : '✓ 正常 ') + sel + ' ' + w + '×' + h;
    console.log(sel, { w, h, bounds: b, ok: !bad });
  }

  // 高度必须与 index.wxss 的 .chart-* 一一对应，否则预览量的是一个真机上不存在的高度
  paint('#hist', histogramScene, 190);
  paint('#survival', survivalScene, 208);
  paint('#strip', stripScene, 230);

  /* 首屏那个大倒计时也让它真的走起来。
     静态数字看不出位数变化时的宽度跳动 —— 而「秒」每位都在变，
     正是最容易把那一行顶出卡片的时刻。预览页得能看见这件事。 */
  const pcdRow = document.getElementById('pcd');
  if (pcdRow) {
    const etaAt = Number(pcdRow.dataset.eta);
    const kind = pcdRow.dataset.kind;
    const tick = () => {
      const cd = predCountdown({ etaAt, etaKind: kind }, Date.now());
      if (!cd) return;
      pcdRow.innerHTML = cd.groups
        .map(
          (g) => '<div class="pcd-g"><span class="pcd-v">' + g.v + '</span><span class="pcd-u">' + g.unit + '</span></div>'
        )
        .join('');
      const cap = pcdRow.parentElement.querySelector('.pcd-cap');
      if (cap) cap.textContent = cd.label;
      pcdRow.parentElement.classList.toggle('is-over', cd.over);
    };
    tick();
    setInterval(tick, 1000);
  }

  /* 右上角「观测中」跟真实时钟走。静态时间看不出它在不在动，
     而这一处恰恰是「必须会动」的地方 —— 预览页也得能验收这一点。 */
  const upd = document.getElementById('upd');
  if (upd && typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
    const bj = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', hourCycle: 'h23',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const tickClock = () => { upd.textContent = bj.format(Date.now()); };
    tickClock();
    setInterval(tickClock, 1000);
  }
</script>
</body>
</html>
`;

await mkdir(resolve(ROOT, 'dist'), { recursive: true });
await writeFile(resolve(ROOT, 'dist/miniprogram-preview.html'), html, 'utf8');
console.log(`✓ dist/miniprogram-preview.html  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
console.log('  用静态服务器打开（ES module 不能走 file://）：');
console.log('    python3 -m http.server 8801  然后访问 http://127.0.0.1:8801/dist/miniprogram-preview.html');
