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
import { detectSignals } from '../src/lib/signals.mjs';
import { elapsed, reelGroups, fmtDateTime, fmtClock, verdict as makeVerdict } from '../miniprogram/utils/format.js';
import { buildSignal, buildMetrics, buildForecast } from '../miniprogram/utils/view.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = async (p) => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'));

/* ---------------------------- rpx → px ---------------------------- */

const RPX = 0.5; // 375px 视口下 1rpx = 0.5px
const wxssToCss = (s) =>
  s.replace(/([\d.]+)rpx/g, (_, n) => `${Math.round(Number(n) * RPX * 100) / 100}px`);

/* ------------------------------ 数据 ------------------------------ */

const [resets, tweets] = await Promise.all([read('data/resets.json'), read('data/tweets.json')]);
const now = Date.now();

const chart = buildChartData(resets.records, now);
const prediction = predictAll(resets.records, { now });
const signals = detectSignals(tweets.tweets, { now, account: 'thsottiaux' });

const lastAt = new Date(chart.lastAt).getTime();
const counter = reelGroups(elapsed(lastAt));
const v = makeVerdict(chart.pct);
const metrics = buildMetrics(chart);
const sig = buildSignal(signals);
const forecast = buildForecast(prediction);

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

const signalHtml = sig.show
  ? `<div class="sig" data-level="${sig.level}">
      <div class="sig-head">
        <span class="badge">${esc(sig.badge)}</span>
        <span class="sig-title">${esc(sig.title)}</span>
        ${sig.precision ? `<span class="prec">粒度：${esc(sig.precision)}</span>` : ''}
      </div>
      ${
        sig.window
          ? `<div class="win">
              <div class="wrow"><span class="k">Tibo 当地时间</span><span class="v">${esc(sig.window.sourceZone)}</span><span class="z">${esc(sig.window.srcOffset)}</span></div>
              <div class="wrow"><span class="k">北京时间</span><span class="v">${esc(sig.window.userZone)}</span><span class="z">${esc(sig.window.usrOffset)}</span></div>
              <div class="wfoot">${esc(sig.window.diffText)}${sig.window.crosses ? ' · 换算到北京时间后会跨自然日' : ''}</div>
            </div>`
          : ''
      }
      <div class="quote">${esc(sig.text)}</div>
      <div class="meta">
        <span>发布于 ${esc(sig.createdText)}</span>
        ${sig.timeNote ? `<span class="note">${esc(sig.timeNote)}</span>` : ''}
        ${sig.reason ? `<span>判定依据：${esc(sig.reason)}</span>` : ''}
      </div>
    </div>`
  : `<div class="sig-idle"><span class="idot"></span><span>最近 <b>${sig.checked}</b> 条推文中没有检测到重置预告</span><span class="isub">已扫描 ${sig.lookback} 天内的公开发言</span></div>`;

const metricsHtml = metrics
  .map(
    (m) => `<div class="metric"><div class="k">${esc(m.k)}</div><div class="v ${m.hi ? 'hl' : ''}">${esc(
      m.v
    )}${m.u ? `<span class="u">${esc(m.u)}</span>` : ''}</div><div class="note">${esc(m.note)}</div></div>`
  )
  .join('');

const forecastHtml = forecast
  ? `<div class="fc">
      <div class="fc-main">
        <div class="k">中位剩余等待</div>
        <div class="v">${forecast.q50}<span class="u">天</span></div>
        <div class="range">${forecast.hoursText ? forecast.hoursText + ' · ' : ''}80% 区间 <span class="b">${esc(
          forecast.rangeText
        )}</span> 天</div>
      </div>
      <div class="fc-bars">
        ${forecast.bars
          .map(
            (b) =>
              `<div class="bar"><span class="lb">${esc(b.label)}</span><div class="track"><div class="fill" style="width:${b.w}%"></div></div><span class="pv">${esc(
                b.pv
              )}</span></div>`
          )
          .join('')}
        <div class="cal-tag">概率未经校准 · 实际发生率通常更高</div>
      </div>
    </div>
    <div class="card fc-meta">
      <div class="fc-block">
        <div class="bh">样本外回测 · n=${forecast.cal.n}</div>
        ${forecast.cal.rows
          .map(
            (r) =>
              `<div class="row"><span class="rk">${esc(r.k)}</span><span class="rv ${r.ok ? 'good' : 'bad'}">${esc(
                r.v
              )}</span><span class="rj">${esc(r.j)}</span></div>`
          )
          .join('')}
      </div>
      <div class="fc-block">
        <div class="bh">节奏在加速</div>
        ${forecast.phases
          .map(
            (p) =>
              `<div class="ph"><span class="pi">第 ${p.i} 段</span><span class="pt">${esc(p.from)} → ${esc(
                p.to
              )}</span><span class="pm">${p.mean} 天</span><span class="pn">n=${p.n} · 最大 ${p.max} 天</span></div>`
          )
          .join('')}
        <div class="bfoot">${esc(forecast.phaseSummary)}</div>
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
    <div class="pulse"><span class="dot"></span><span>观测中 · ${esc(fmtClock(now))}</span></div>
  </div>

  ${signalHtml}

  <div class="hero">
    <div class="label">距上一次额度重置</div>
    <div class="counter">${counterHtml}</div>
    <div class="since">上次重置 ${esc(fmtDateTime(lastAt))} · 已过 ${elapsed(lastAt).d} 天</div>
    <div class="verdict v-${v.cls}"><span class="b">${esc(v.text)}</span><span class="sep"> · </span><span>${esc(
      v.tail
    )}</span></div>
  </div>

  <div class="metrics">${metricsHtml}</div>

  <div class="sec-head"><span class="t">还要等多久</span></div>
  ${forecastHtml}

  <div class="sec-head"><span class="t">等待生存曲线</span><span class="h">n = ${chart.gapDays.length} 次历史间隔</span></div>
  <div class="lede">纵轴是「到第 X 天为止，历史上百分之多少的重置已经发生」。你现在的位置标在曲线上。</div>
  <div class="card"><canvas id="survival" class="chart chart-survival"></canvas></div>

  <div class="sec-head"><span class="t">每次间隔的离散分布</span></div>
  <div class="lede">每一次重置到下一次重置的间隔天数。平均值被右侧的极端值拉高了。</div>
  <div class="card">
    <canvas id="strip" class="chart chart-strip"></canvas>
    <div class="legend">
      <div class="lg"><span class="sw sw-lan"></span>常规间隔</div>
      <div class="lg"><span class="sw sw-mist"></span>偏长间隔</div>
      <div class="lg"><span class="sw sw-cin"></span>极端长等待</div>
    </div>
  </div>

  <div class="foot">
    <div>数据：公开推文记录 · 最后更新 ${esc(fmtDateTime(now))} 北京</div>
    <div>观测账号 x.com/thsottiaux</div>
  </div>

</div>
</div>

<script type="application/json" id="chart-data">${JSON.stringify(chart)}</script>
<script type="module">
  // 关键：这里 import 的是**发布用的同一份**几何与绘制代码，不是复制品
  import { survivalScene, stripScene, sceneBounds } from '../src/lib/scene.js';
  import { drawScene } from '../miniprogram/utils/draw.js';

  const chart = JSON.parse(document.getElementById('chart-data').textContent);
  const dpr = window.devicePixelRatio || 2;

  function paint(sel, make, heightCss) {
    const cv = document.querySelector(sel);
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

  paint('#survival', survivalScene, 208);
  paint('#strip', stripScene, 230);
</script>
</body>
</html>
`;

await mkdir(resolve(ROOT, 'dist'), { recursive: true });
await writeFile(resolve(ROOT, 'dist/miniprogram-preview.html'), html, 'utf8');
console.log(`✓ dist/miniprogram-preview.html  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
console.log('  用静态服务器打开（ES module 不能走 file://）：');
console.log('    python3 -m http.server 8801  然后访问 http://127.0.0.1:8801/dist/miniprogram-preview.html');
