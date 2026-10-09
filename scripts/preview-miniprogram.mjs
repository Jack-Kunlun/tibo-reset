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
import { elapsed, reelGroups, fmtDateTime, fmtClockSec, toTs, verdict as makeVerdict } from '../miniprogram/utils/format.js';
import { buildGauge, buildSignal, buildMetrics, buildForecast, buildOutlookView, predCountdown, readoutParts } from '../miniprogram/utils/view.js';

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

const records = (chart.records || []).slice(-17).reverse().map((r, i) => {
  const ts = toTs(r && r.at);
  return {
    key: (r && r.id) || (r && r.at) || `record-${i}`,
    date: Number.isFinite(ts) ? fmtDateTime(ts).slice(5) : '时间未知',
    type: r && r.type === 'credit' ? '发券型' : '额度重置',
    text: (r && r.text) || '',
    url: (r && r.url) || '',
  };
});
const trendCount = Math.min(7, chart.gapDays.length);
const trendRecords = (chart.records || []).slice(-trendCount);
const trendFirst = trendRecords.length ? fmtDateTime(toTs(trendRecords[0].at)).slice(5, 10) : '';
const trendLast = trendRecords.length ? fmtDateTime(toTs(trendRecords[trendRecords.length - 1].at)).slice(5, 10) : '';
const coverage = forecast?.backtest?.rows?.find((row) => row.k === '80% 区间覆盖率');
const recentPhase = forecast?.pace?.phases?.length ? forecast.pace.phases[forecast.pace.phases.length - 1] : null;
const announcementParts = [];
if (pred?.briefData?.announcedHard > 0) announcementParts.push(pred.briefData.announcedHard + ' 条硬承诺');
if (pred?.briefData?.announcedSoft > 0) announcementParts.push(pred.briefData.announcedSoft + ' 条同日提及');
const basisRows = pred && forecast
  ? [
      {
        label: pred.etaKind === 'announced' ? '公告依据' : '历史推算',
        value: pred.etaKind === 'announced'
          ? announcementParts.join(' · ') || '公告窗口已确认'
          : (Number.isFinite(pred.briefData?.intervals) ? pred.briefData.intervals : '—') + ' 次间隔',
      },
      { label: '80% 区间覆盖率', value: coverage ? coverage.v : '—' },
      { label: '近期平均间隔', value: recentPhase ? recentPhase.mean + recentPhase.unit.replace(/\s+/g, '') : '—' },
    ]
  : [];

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/* ------------------------------ 片段 ------------------------------ */

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

const counterHtml = counter.map((g) =>
  '<div class="grp"><div class="reels">' + g.digits.map((d) =>
    '<div class="reel"><div class="strip" style="transform:translateY(-' + d + 'em)">' +
    DIGITS.map((n) => '<div class="dg">' + n + '</div>').join('') + '</div></div>'
  ).join('') + '</div><span class="unit">' + esc(g.unit) + '</span></div>'
).join('');

const pcdHtml = (groups) => (groups || []).map((g) =>
  '<div class="pcd-g"><span class="pcd-v">' + esc(g.v) + '</span><span class="pcd-u">' + esc(g.unit) + '</span></div>'
).join('');

const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
const windowHtml = (w, scope) => !w ? '' :
  '<div class="' + scope + ' win">' +
    '<div class="wrow"><span class="k">Tibo 当地时间</span><span class="v">' + esc(w.sourceZone) + '</span><span class="z">' + esc(w.srcOffset) + '</span></div>' +
    '<div class="wrow"><span class="k">北京时间</span><span class="v">' + esc(w.userZone) + '</span><span class="z">' + esc(w.usrOffset) + '</span></div>' +
    '<div class="wfoot">' + esc(w.diffText) + (w.rangeNote ? ' · ' + esc(w.rangeNote) : '') + '</div>' +
  '</div>';

const predHtml = pred ? (
  '<div id="forecast" class="pred ' + esc(pred.statusClass) + ' ' + esc(pred.confidenceClass) + '" data-status="' + esc(pred.status) + '" data-level="' + esc(pred.confidence) + '">' +
    '<div class="orbit-field" aria-hidden="true">' +
      '<div class="orbit-plane orbit-outer"><div class="orbit-orbiter"><div class="orbit-dot"></div></div></div>' +
      '<div class="orbit-plane orbit-mid"><div class="orbit-orbiter"><div class="orbit-dot"></div></div></div>' +
      '<div class="orbit-plane orbit-inner"><div class="orbit-orbiter"><div class="orbit-dot"></div></div></div>' +
      '<div class="stage-glow"></div><div class="star star-a"></div><div class="star star-b"></div><div class="star star-c"></div><div class="star star-d"></div>' +
    '</div>' +
    '<div class="tap-ring" id="tap-ring" hidden></div>' +
    '<div class="pred-content">' +
      '<div class="pred-head"><span class="pred-t">NEXT RESET</span><span class="pred-badge">置信度 · ' + esc(pred.confidenceLabel) + '</span></div>' +
      '<div class="pred-stage">' +
        '<span class="pred-stage-title">下一次重置预测</span>' +
        '<div class="eta-date" aria-label="预测日期 ' + escAttr(pred.md) + '">' + pred.dateDigits.map((digit) =>
          '<span class="eta-digit entering' + (digit.value === '.' ? ' eta-digit-dot' : '') + '" style="animation-delay:' + escAttr(digit.delay) + '">' + esc(digit.value) + '</span>'
        ).join('') + '</div>' +
        '<span class="eta-detail">' + esc(pred.etaDetail) + '</span>' +
        '<div class="pred-countdown' + (predCd && predCd.over ? ' is-over' : '') + '">' +
          '<span class="pcd-cap">' + esc(predCd && predCd.over ? predCd.label : '预计还需等待') + '</span>' +
          '<div class="pcd-row" id="pcd" data-eta="' + pred.etaAt + '" data-kind="' + esc(pred.etaKind) + '">' +
            pcdHtml(predCd ? predCd.groups : []) +
          '</div>' +
        '</div>' +
      '</div>' +
      (pred.band ? '<div class="pred-range"><span class="range-label">' + (pred.etaKind === 'announced' ? '公告窗口' : '80% 预测区间') + '</span><span class="range-value">' + esc(pred.band) + '</span></div>' : '') +
    '</div>' +
  '</div>'
) : '';

const signalHtml = sig.show
  ? '<div class="sig sig-' + esc(sig.level) + '" id="signal-toggle" data-level="' + esc(sig.level) + '">' +
      '<span class="signal-dot"></span><span class="signal-badge">' + esc(sig.badge) + '</span>' +
      '<span class="signal-title">' + esc(sig.title) + '</span>' +
      '<span class="signal-count">' + (sig.evCount ? esc(sig.evCount) + ' 条依据 ›' : '查看线索 ›') + '</span>' +
    '</div>'
  : '<div class="sig-idle" id="signal-toggle"><span class="idle-ico"></span><span class="idle-body">' +
      '<span class="idle-t">最近 <b>' + esc(sig.checked) + '</b> 条推文中没有检测到重置预告</span>' +
      (sig.windowFrom ? '<span class="idle-sub">时间窗自 ' + esc(sig.windowFrom) + ' 起</span>' : '') +
    '</span><span class="idle-go">›</span></div>';

const evidenceHtml = (sig.ev || []).map((e) =>
  '<div class="ev-item ' + esc(e.weight) + '"><div class="ev-top">' +
    '<span class="ev-when">' + esc(e.when) + ' 北京</span><span class="ev-tag ' + esc(e.weight) + '">' + esc(e.tag) + '</span>' +
    (e.via ? '<span class="ev-via">' + esc(e.via) + '</span>' : '') +
    (e.word ? '<span class="ev-word">' + esc(e.word) + '</span>' : '') +
  '</div><div class="ev-quote">' + esc(e.text) + '</div>' +
  (e.url ? '<a class="ev-link" href="' + escAttr(e.url) + '" target="_blank" rel="noopener">打开原推</a>' : '') + '</div>'
).join('');

const signalDetailHtml = sig.show
  ? '<div class="signal-detail" id="signal-details" hidden>' +
      windowHtml(sig.window, 'signal-window') +
      (sig.evCount ? (sig.evNote ? '<div class="ev-note">' + esc(sig.evNote) + '</div>' : '') + evidenceHtml : '<div class="quote">' + esc(sig.text) + '</div>') +
      '<div class="meta">' +
        (sig.createdText ? '<span>发布于 ' + esc(sig.createdText) + '</span>' : '') +
        (sig.timeNote ? '<span class="note">' + esc(sig.timeNote) + '</span>' : '') +
        (sig.reason ? '<span>判定依据：' + esc(sig.reason) + '</span>' : '') +
        (sig.url ? '<a class="link" href="' + escAttr(sig.url) + '" target="_blank" rel="noopener">打开原推</a>' : '') +
      '</div>' +
    '</div>'
  : '';

const progHtml = sig.program && sig.program.show
  ? '<div class="prog"><div class="prog-head" id="program-toggle">' +
      '<span class="program-icon">28</span><span class="program-copy"><span class="prog-tag">每日重置窗口</span>' +
        '<span class="prog-left">共 ' + esc(sig.program.days) + ' 天 · 还剩 ' + esc(sig.program.daysLeft) + ' 天</span></span>' +
      '<span class="prog-toggle" id="program-mark">＋</span></div>' +
      '<div class="prog-body" id="program-body" hidden>' +
        '<span class="prog-rule">每天要么发一个改进、要么给一次完整重置 —— 期间任何一天都可能重置</span>' +
        windowHtml(sig.program.window, 'program-window') +
        '<div class="prog-meta">' + (sig.program.announcedText ? '<span>发布于 ' + esc(sig.program.announcedText) + '</span>' : '') +
          (sig.program.url ? '<a class="prog-link" href="' + escAttr(sig.program.url) + '" target="_blank" rel="noopener">打开原推</a>' : '') + '</div>' +
      '</div></div>'
  : '';

const basisHtml = basisRows.map((r) =>
  '<div class="basis-row"><span class="basis-key">' + esc(r.label) + '</span><span class="basis-value" aria-label="' + escAttr(r.value) + '">' +
    readoutParts(r.value).map((part) => '<span class="' + (part.numeric ? 'basis-number' : 'basis-unit') + '">' + esc(part.text) + '</span>').join('') +
  '</span></div>'
).join('');

const recordHtml = (r) =>
  '<div class="record-row"><div class="record-top"><span class="record-date">' + esc(r.date) + '</span>' +
    '<span class="record-type' + (r.type === '发券型' ? ' credit' : '') + '">' + esc(r.type) + '</span></div>' +
    '<div class="record-text">' + esc(r.text) + '</div>' +
    (r.url ? '<a class="record-link" href="' + escAttr(r.url) + '" target="_blank" rel="noopener">打开原推</a>' : '') + '</div>';

const recentHtml = records.slice(0, 3).map(recordHtml).join('');
const moreHtml = records.slice(3, 17).map(recordHtml).join('');

const metricsHtml = metrics.map((m) =>
  '<div class="metric"><div class="v' + (m.hi ? ' hl' : '') + '">' + esc(m.v) +
    (m.u ? '<span class="u">' + esc(m.u) + '</span>' : '') + '</div>' +
    '<div class="k">' + esc(m.k) + '</div><div class="note">' + esc(m.note) + '</div></div>'
).join('');

const forecastHtml = forecast
  ? '<div class="bc-grid">' +
      '<div class="bc" data-bc="wait"><div class="bc-h"><div class="ico ico-wait"></div><span class="bc-t">中位剩余等待</span></div>' +
        '<div class="bc-num"><span class="b">' + esc(forecast.wait.num) + '</span><span class="u">' + esc(forecast.wait.unit) + '</span></div>' +
        '<div class="bc-range">' + esc(forecast.wait.range) + '</div>' +
        forecast.wait.bars.map((b) => '<div class="bc-bar"><span class="lb">' + esc(b.label) + '</span><span class="track"><span class="fill" style="width:' + b.w + '%"></span></span><span class="pv">' + esc(b.pv) + '</span></div>').join('') +
        '<div class="bc-note is-warn">' + esc(forecast.wait.warn) + '</div></div>' +
      '<div class="bc" data-bc="backtest"><div class="bc-h"><div class="ico ico-bars"></div><span class="bc-t">样本外回测</span></div>' +
        '<div class="bc-sub">n = ' + esc(forecast.backtest.n) + '（阈值 ≥ ' + esc(forecast.backtest.minN) + '）</div>' +
        forecast.backtest.rows.map((r) => '<div class="bc-row"><span class="k">' + esc(r.k) + '</span><span class="v ' + (r.ok ? 'good' : 'bad') + '">' + esc(r.v) + '</span><span class="j">' + esc(r.j) + '</span></div>').join('') +
        '<div class="bc-note" data-note="backtest">' + esc(forecast.backtest.note) + '</div></div>' +
      '<div class="bc" data-bc="pace"><div class="bc-h"><div class="ico ico-trend"></div><span class="bc-t">节奏分段</span></div>' +
        forecast.pace.phases.map((phase) => '<div class="ph"><span class="pi">第 ' + phase.i + ' 段</span><span class="pt">' + esc(phase.from) + ' → ' + esc(phase.to) + '</span><span class="pm">' + phase.mean + '<span class="u">' + esc(phase.unit) + '</span></span><span class="pn">n=' + phase.n + ' · 最大 ' + esc(phase.max) + '</span></div>').join('') +
        '<div class="bc-note">' + esc(forecast.pace.note) + '</div></div>' +
    '</div>'
  : '';

const historyHtml =
  '<div class="section-head detail-heading"><span class="section-title">历史分布</span><span class="section-sub">n = ' + chart.gapDays.length + ' 次历史间隔</span></div>' +
  '<div class="lede">三张图看同一批已完成间隔：常见区间、等待生存曲线与每次间隔分布。</div>' +
  '<div class="hr-grid">' +
    (chart.hist && chart.hist.total ? '<div class="hr"><div class="hr-h"><span class="hr-t">重置通常发生在第几天</span><span class="hr-n">n = ' + chart.gapDays.length + '</span></div><canvas id="hist" class="chart chart-hist"></canvas></div>' : '') +
    '<div class="hr"><div class="hr-h"><span class="hr-t">等待生存曲线</span><span class="hr-n">n = ' + chart.gapDays.length + '</span></div><canvas id="survival" class="chart chart-survival"></canvas></div>' +
    '<div class="hr"><div class="hr-h"><span class="hr-t">每次间隔的离散分布</span><span class="hr-n">n = ' + chart.gapDays.length + '</span></div><canvas id="strip" class="chart chart-strip"></canvas>' +
      '<div class="legend"><div class="lg"><span class="sw sw-lan"></span>常规间隔</div><div class="lg"><span class="sw sw-mist"></span>偏长间隔</div><div class="lg"><span class="sw sw-cin"></span>极端长等待</div></div></div>' +
  '</div>';

const appWxss = wxssToCss(await readFile(resolve(ROOT, 'miniprogram/app.wxss'), 'utf8'));
const pageWxss = wxssToCss(await readFile(resolve(ROOT, 'miniprogram/pages/index/index.wxss'), 'utf8'));

const normalize = [
  '.reel .dg{display:block}.strip{display:block}',
  'body{margin:0;background:#e9e7f0;padding:24px 0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
  '.phone{width:375px;max-width:100%;margin:0 auto;background:#f5f4fb;min-height:100vh;box-shadow:0 8px 40px rgba(0,0,0,.18)}',
  '.phone{position:relative}.preview-capsule{position:absolute;z-index:5;top:31px;right:9px;width:88px;height:32px;display:flex;align-items:center;justify-content:space-around;border:1px solid #d8d6df;border-radius:99px;background:rgba(255,255,255,.94);color:#292741;font-size:13px;line-height:1}.preview-capsule i{height:18px;border-left:1px solid #d8d6df}',
  '.prog-body[hidden],.signal-detail[hidden],.more-records[hidden],.detail-area[hidden],.tap-ring[hidden]{display:none}',
  '.detail-area{display:block}.trend-chart{height:160px}',
].join('');

const safeChart = JSON.stringify(chart).replace(/</g, '\\u003c');
const html = '<!DOCTYPE html>\n' +
'<html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />' +
'<title>小程序布局预览 · 等 TIBO 按按钮</title><style>' + appWxss + pageWxss + normalize + '</style></head><body>' +
'<div class="phone"><div class="preview-capsule" aria-hidden="true"><span>•••</span><i></i><span>◉</span></div><div class="wrap motion-on" id="mini-page"><div class="aurora-sky" aria-hidden="true">' +
'<div class="aurora-cloud cloud-mint"></div><div class="aurora-cloud cloud-violet"></div><div class="aurora-cloud cloud-blue"></div></div>' +
'<div class="page-content"><div class="top" style="padding-top:24px"><div class="brand-line" style="min-height:46px;padding-right:115px"><div class="brand"><span class="brand-mark"><i class="brand-core"></i></span>' +
'<span class="brand-copy"><span class="h1">等 TIBO 按按钮</span><span class="sub">RESET OBSERVATORY</span></span></div>' +
' </div><div class="top-tools"><span class="pulse"><i class="dot"></i><span>观测中 · <span id="upd">' + esc(fmtClockSec(now)) + '</span></span></span></div></div>' +
'<div class="hero" id="elapsed"><div class="elapsed-line"><span class="label">距上次重置</span><div class="counter" id="counter">' + counterHtml + '</div></div>' +
'<span class="since">上次 ' + esc(fmtDateTime(lastAt).slice(5)) + ' · 北京时间</span></div>' +
predHtml + signalHtml + signalDetailHtml + progHtml +
'<div class="basis card"><div class="section-head"><span class="section-title">预测依据</span></div>' +
basisHtml + '</div>' +
'<div class="trend-panel card"><div class="section-head"><span class="section-title">历史节奏</span><span class="section-sub">最近 ' + trendCount + ' 次完整间隔</span></div>' +
'<canvas type="2d" id="trend" class="trend-chart"></canvas><div class="trend-caption"><span>' + esc(trendFirst) + '</span><span>间隔天数</span><span>' + esc(trendLast) + '</span></div></div>' +
'<div class="records card"><div class="section-head"><span class="section-title">最近记录</span><span class="section-sub">' + chart.gapDays.length + ' 次历史间隔</span></div>' +
recentHtml + '<div role="button" tabindex="0" class="more-records-toggle" id="more-toggle"><span>再看 ' + Math.min(14, Math.max(0, records.length - 3)) + ' 条</span><span>＋</span></div>' +
'<div class="more-records" id="more-records" hidden>' + moreHtml + '</div><a class="history-link" href="/pages/history/index">查看完整历史记录 →</a></div>' +
'<div role="button" tabindex="0" class="detail-toggle" id="detail-toggle"><span>展开回测、历史图与统计</span><span class="detail-arrow">＋</span></div>' +
'<div class="detail-area" id="detail-area" hidden><div class="prediction-disclosure card"><div class="section-head"><span class="section-title">预测说明</span></div>' +
'<span class="disclosure-line">等待状态：' + esc(v.text + ' · ' + v.tail) + '</span><span class="disclosure-line">' + esc(pred.statusLabel + ' · ' + pred.statusNote) + '</span>' +
'<span class="disclosure-line">预测算于 ' + esc(pred.updatedText) + '</span><span class="disclosure-line">' + esc(pred.brief) + '</span></div>' +
'<div class="section-head detail-heading"><span class="section-title">模型侧辅助数据</span><span class="section-sub">' + esc(forecast ? forecast.hint : '') + '</span></div>' +
forecastHtml + '<div class="bc-note pred-brief"><b>预测判据：</b>' + esc(pred ? pred.brief : '') + '</div>' + historyHtml +
'<div class="section-head detail-heading"><span class="section-title">样本摘要</span></div><div class="metrics">' + metricsHtml + '</div></div>' +
'<div class="foot"><div>数据：公开推文记录 · 最近一次采集 ' + esc(fmtDateTime(now)) + ' 北京</div><div>观测账号 x.com/thsottiaux</div></div>' +
'</div></div></div>' +
'<script type="application/json" id="chart-data">' + safeChart + '</script>' +
'<script type="module">' +
"import { rhythmScene, survivalScene, stripScene, histogramScene, sceneBounds } from '../src/lib/scene.js';" +
"import { drawScene } from '../miniprogram/utils/draw.js';" +
"import { predCountdown } from '../miniprogram/utils/view.js';" +
"import { elapsed, reelGroups, fmtClockSec } from '../miniprogram/utils/format.js';" +
"const chart=JSON.parse(document.getElementById('chart-data').textContent), root=document.getElementById('mini-page'), dpr=window.devicePixelRatio||2;" +
"const lastAt=" + lastAt + ", digits='0123456789';" +
"function paint(sel,make){const cv=document.querySelector(sel);if(!cv)return;const rect=cv.getBoundingClientRect(),w=Math.round(rect.width),h=Math.round(rect.height);if(!w||!h)return;cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr);const ctx=cv.getContext('2d');ctx.scale(dpr,dpr);const scene=make(chart,{width:w,height:h});drawScene(ctx,scene,dpr);const b=sceneBounds(scene);const bad=b.minX<-.5||b.maxX>w+.5||b.minY<-.5||b.maxY>h+.5;console.log(sel,{w,h,bounds:b,ok:!bad});}" +
"function paintTrend(){paint('#trend',rhythmScene)}" +
"function paintDetails(){paint('#hist',histogramScene);paint('#survival',survivalScene);paint('#strip',stripScene)}" +
"function renderCounter(now){const el=elapsed(lastAt,now);return reelGroups(el).map(g=>'<div class=\"grp\"><div class=\"reels\">'+g.digits.map(d=>'<div class=\"reel\"><div class=\"strip\" style=\"transform:translateY(-'+d+'em)\">'+digits.split('').map(n=>'<div class=\"dg\">'+n+'</div>').join('')+'</div></div>').join('')+'</div><span class=\"unit\">'+g.unit+'</span></div>').join('')}" +
"function tick(){const now=Date.now(),pcd=document.getElementById('pcd'),upd=document.getElementById('upd'),counter=document.getElementById('counter');if(pcd){const cd=predCountdown({etaAt:Number(pcd.dataset.eta),etaKind:pcd.dataset.kind},now);if(cd){pcd.innerHTML=cd.groups.map(g=>'<div class=\"pcd-g\"><span class=\"pcd-v\">'+g.v+'</span><span class=\"pcd-u\">'+g.unit+'</span></div>').join('');pcd.parentElement.querySelector('.pcd-cap').textContent=cd.label;pcd.parentElement.classList.toggle('is-over',cd.over)}}if(upd)upd.textContent=fmtClockSec(now);if(counter)counter.innerHTML=renderCounter(now)}" +
"let timer=null;function syncMotion(){const visible=!document.hidden;root.classList.toggle('motion-on',visible);root.classList.toggle('motion-off',!visible)}" +
"document.getElementById('program-toggle')?.addEventListener('click',()=>{const body=document.getElementById('program-body'),mark=document.getElementById('program-mark');body.hidden=!body.hidden;mark.textContent=body.hidden?'＋':'−'});" +
"document.getElementById('signal-toggle')?.addEventListener('click',()=>{const body=document.getElementById('signal-details');if(body)body.hidden=!body.hidden});" +
"document.getElementById('more-toggle')?.addEventListener('click',e=>{const body=document.getElementById('more-records');body.hidden=!body.hidden;e.currentTarget.querySelector('span').textContent=body.hidden?'再看 '+Math.min(14,Math.max(0,chart.records.length-3))+' 条':'收起较早记录';e.currentTarget.lastElementChild.textContent=body.hidden?'＋':'−'});" +
"document.getElementById('detail-toggle').addEventListener('click',e=>{const body=document.getElementById('detail-area');body.hidden=!body.hidden;e.currentTarget.querySelector('span').textContent=body.hidden?'展开回测、历史图与统计':'收起详细观测数据';e.currentTarget.lastElementChild.textContent=body.hidden?'＋':'−';if(!body.hidden)requestAnimationFrame(paintDetails)});" +
"const predCard=document.getElementById('forecast'),ring=document.getElementById('tap-ring');if(predCard&&ring){let ringTimer;predCard.addEventListener('pointerdown',e=>{if(document.hidden)return;const r=predCard.getBoundingClientRect();ring.hidden=false;ring.style.left=(e.clientX-r.left)+'px';ring.style.top=(e.clientY-r.top)+'px';ring.style.animation='none';void ring.offsetWidth;ring.style.animation='';clearTimeout(ringTimer);ringTimer=setTimeout(()=>{ring.hidden=true},900)})}" +
"function start(){if(timer)return;tick();timer=setInterval(tick,1000)}function stop(){if(timer){clearInterval(timer);timer=null}}document.addEventListener('visibilitychange',()=>{syncMotion();if(document.hidden)stop();else start()});" +
"syncMotion();paintTrend();start();" +
'</script></body></html>';

await mkdir(resolve(ROOT, 'dist'), { recursive: true });
await writeFile(resolve(ROOT, 'dist/miniprogram-preview.html'), html, 'utf8');
console.log('✓ dist/miniprogram-preview.html  ' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB');
console.log('  用静态服务器打开（ES module 不能走 file://）：');
console.log('    python3 -m http.server 8801  然后访问 http://127.0.0.1:8801/dist/miniprogram-preview.html');
