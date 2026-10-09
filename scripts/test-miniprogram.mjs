#!/usr/bin/env node
/**
 * 小程序侧校验。
 *
 * 小程序没法在 CI 里直接跑（要微信开发者工具），但**页面逻辑本身是纯 JS**，
 * 只依赖两个宿主对象：Page() 和 wx.*。把它们打桩，就能在 Node 里把整条
 * 渲染链路走一遍 —— 这能在上传之前挡住绝大多数「打开就白屏」的低级错误：
 * 字段拼错、undefined 渲染、数组越界、canvas 几何画出画布外。
 *
 * 校验三件事：
 *   1. 页面配置能被加载，onLoad/onReady 不抛异常
 *   2. setData 出去的每一份数据都能安全渲染（无 NaN / undefined / null）
 *   3. 图表场景在所有目标宽度下都落在画布内（这是「图变成一片空白」的根因之一）
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SNAPSHOT_REL } from '../src/lib/snapshot.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------ 前置 ------------------------------ */

// 快照是构建产物、不入库（D-027），而 `miniprogram/utils/api.js` 在**模块顶层**
// import 它 —— 缺了它这里只会抛一句 MODULE_NOT_FOUND，看的人会以为代码坏了。
// 所以先把它换成一句能照做的提示（同 acceptance.mjs 对 SITE_URL 的做法）。
if (!existsSync(resolve(ROOT, SNAPSHOT_REL))) {
  console.error(`✗ 缺少构建产物 ${SNAPSHOT_REL}：小程序代码在模块顶层 import 它，没有它加载不了页面。`);
  console.error('  生成：node scripts/build-snapshot.mjs');
  console.error('  （npm test 的 pretest 会自动跑它；要连 dist 一起重建则用 npm run build）');
  process.exit(1);
}

/* ------------------------------ 断言工具 ------------------------------ */

let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/* ------------------------------ 宿主打桩 ------------------------------ */

const storage = new Map();

// 记录所有 setData 载荷，供后面统一做「可渲染性」扫描
const renders = [];

function makeWx(record) {
  return {
    request(opts) {
      record.requestCount++;
      // 记下「第一次发请求时已经渲染过几次」—— 用来证明首屏是**先出图再联网**的
      if (record.rendersAtFirstRequest === undefined) record.rendersAtFirstRequest = renders.length;
      // 默认让请求失败：这是「接口不可用」这一路的模拟（域名没备案、后端挂了、
      // 超时都归到这里）。要测成功路径的用例用 record.onRequest 临时接管，测完恢复。
      if (record.onRequest) return record.onRequest(opts);
      if (opts && opts.fail) opts.fail({ errMsg: 'url not in domain list' });
    },
    createSelectorQuery() {
      const q = {
        in: () => q,
        select: () => q,
        fields: () => q,
        // 返回一个假的 canvas 节点：宽度 341、高度按选择器给
        exec: (cb) => cb([{ node: makeFakeCanvas(), width: 341, height: 208 }]),
      };
      return q;
    },
    getWindowInfo: () => ({ pixelRatio: 3, windowWidth: 375, statusBarHeight: 24 }),
    getMenuButtonBoundingClientRect: () => ({ left: 270, bottom: 64 }),
    getSystemInfoSync: () => ({ pixelRatio: 3 }),
    // 单页模式判断用（utils/share.js）。两个接口**分开打桩**，因为语义不同：
    // getEnterOptionsSync 反映「这一次」怎么进来，getLaunchOptionsSync 只反映冷启动
    // 那一次。混用一个值就测不出「先自己打开、再从朋友圈点回来」这条最常见的路径。
    getEnterOptionsSync: () => ({ scene: record.enterScene }),
    getLaunchOptionsSync: () => ({ scene: record.launchScene }),
    setStorageSync: (k, v) => storage.set(k, v),
    getStorageSync: (k) => storage.get(k),
    removeStorageSync: (k) => storage.delete(k),
    // 复制相关：这里要记录调用，否则「失败必须有反馈」这条断言无从下手
    setClipboardData(opts) {
      record.clipboard.push(opts && opts.data);
      if (record.clipboardFails) {
        if (opts && opts.fail) opts.fail(record.clipboardErr);
        return;
      }
      if (opts && opts.success) opts.success({});
    },
    showToast(opts) {
      record.toasts.push(opts && opts.title);
    },
    stopPullDownRefresh: () => {},
    showLoading: () => {},
    hideLoading: () => {},
    // F9：code 一次性，这里每次调用都换一个，能测出「有没有复用旧 code」
    login(opts) {
      record.loginCount++;
      if (opts && opts.success) opts.success({ code: `code-${record.loginCount}` });
    },
    requestSubscribeMessage(opts) {
      const ids = (opts && opts.tmplIds) || [];
      record.subscribeCalls.push(ids.join(','));
      const res = {};
      for (const id of ids) res[id] = record.subscribeVerdict;
      if (opts && opts.success) opts.success(res);
    },
  };
}

function makeFakeCanvas() {
  const ctx = {
    scale() {},
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    arc() {},
    fillText() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    setLineDash() {},
  };
  return { width: 0, height: 0, getContext: () => ctx };
}

let captured = null;
globalThis.Page = (cfg) => {
  captured = cfg;
};
globalThis.App = () => {};
globalThis.getApp = () => ({ globalData: {} });
// 计时器换成可追踪的句柄，否则 Node 进程会被 setInterval 吊住；同时核对页面隐藏时清理。
let intervalId = 0;
const activeIntervals = new Set();
globalThis.setInterval = () => {
  const id = ++intervalId;
  activeIntervals.add(id);
  return id;
};
globalThis.clearInterval = (id) => activeIntervals.delete(id);

/* ------------------------------ 加载页面 ------------------------------ */

const PAGE_PATH = resolve(ROOT, 'miniprogram/pages/index/index.js');

const wxRecord = {
  requestCount: 0,
  loginCount: 0,
  subscribeCalls: [],
  subscribeVerdict: 'accept',
  onRequest: null,
  rendersAtFirstRequest: undefined,
  // 复制路径：clipboard 记写入了什么，toasts 记弹了什么，后两个开关模拟失败
  clipboard: [],
  toasts: [],
  clipboardFails: false,
  clipboardErr: null,
  // 进入场景值。undefined = 宿主没给（模拟老基础库）
  enterScene: 1001,
  /** 冷启动场景值。默认 1001（正常打开）—— 与 enterScene 分开才测得出语义差异 */
  launchScene: 1001,
};
globalThis.wx = makeWx(wxRecord);

await import(PAGE_PATH);
if (!captured) {
  console.error('✗ 页面模块没有调用 Page()，无法继续');
  process.exit(1);
}

// 造一个最小页面实例：setData 合并到 data，并记下载荷
const page = Object.assign(Object.create(null), captured, {
  data: JSON.parse(JSON.stringify(captured.data)),
});

/**
 * `setData` 打桩。
 *
 * ⚠ **必须实现路径写法**（`{'signal.cd': …}`）。早先这里是一句
 * `Object.assign(page.data, patch)`，它把 `'signal.cd'` 变成一个**顶层键名**
 * `page.data['signal.cd']` —— 于是所有走路径的写入在测试里都落不到读的那一侧，
 * 而这不报错、只是**测不到**：公告窗口倒计时那一支因此至今零覆盖，
 * 是个「看起来有测试、其实那一段从没跑过」的典型。
 *
 * 真实 `setData` 支持这种写法（官方文档的「数据路径」），端上就是这么用的，
 * 桩不照着实现等于自己放弃了一半覆盖面。
 */
page.setData = (patch, cb) => {
  renders.push(patch);
  for (const key of Object.keys(patch)) {
    if (!key.includes('.')) {
      page.data[key] = patch[key];
      continue;
    }
    const parts = key.split('.');
    let cur = page.data;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (cur[seg] == null || typeof cur[seg] !== 'object') cur[seg] = {};
      cur = cur[seg];
    }
    cur[parts[parts.length - 1]] = patch[key];
  }
  if (typeof cb === 'function') cb();
};

console.log('【1】页面生命周期');
await page.onLoad();
await Promise.resolve();
page.onReady();
await new Promise((r) => setTimeout(r, 30));

check('onLoad / onReady 未抛异常', true);

{
  const originalQuery = wx.createSelectorQuery;
  const drawPage = { ...page, _painting: false, _paintAgain: false };
  let releaseFirst;
  let trendQueries = 0;
  let trendCanvas;
  wx.createSelectorQuery = () => {
    let selector;
    const query = {
      in: () => query,
      select: (value) => { selector = value; return query; },
      fields: () => query,
      exec: (callback) => {
        if (selector === '#trend' && ++trendQueries === 1) {
          releaseFirst = callback;
          return;
        }
        const node = makeFakeCanvas();
        if (selector === '#trend') trendCanvas = node;
        callback([{ node, width: 341, height: 160 }]);
      },
    };
    return query;
  };
  try {
    const firstPaint = drawPage.paint();
    await drawPage.paint();
    // 首次查询时节点还没挂载，随后 setData 完成后的绘制不能被「正在画」吞掉。
    releaseFirst([null]);
    await firstPaint;
    check('视图更新与绘制重叠时，补画已挂载的历史节奏图', trendQueries === 2 && trendCanvas?.width === 1023, `${trendQueries} / ${trendCanvas?.width}`);
  } finally {
    wx.createSelectorQuery = originalQuery;
  }
}
check(
  '自定义导航读取状态栏和胶囊边界',
  page.data.nav.statusBarHeight === 24 && page.data.nav.capsuleReserve === 115 && page.data.nav.brandHeight === 46,
  JSON.stringify(page.data.nav)
);

page.onShow();
check('页面显示时开启唯一的真实时钟', page.data.pageVisible === true && activeIntervals.size === 1, `${page.data.pageVisible} / ${activeIntervals.size}`);
page.onHide();
check('页面隐藏时清除时钟并停下装饰动效', page.data.pageVisible === false && activeIntervals.size === 0, `${page.data.pageVisible} / ${activeIntervals.size}`);

// 首屏不依赖网络 —— 这是「域名没备案也不会白屏」这条设计的可验证形式：
// 发第一次请求时，快照已经渲染过了。若哪天有人把首屏改成等接口回来再渲染，这条会立刻红。
check(
  '首屏先出图：第一次发请求之前快照就已渲染',
  wxRecord.rendersAtFirstRequest === undefined || wxRecord.rendersAtFirstRequest > 0,
  `发请求时已渲染 ${wxRecord.rendersAtFirstRequest} 次`
);

// 联网策略由 config.enabled 决定，断言跟着配置走而不是写死 ——
// 否则改一次开关就得来改测试，测试会慢慢退化成维护成本的装饰品。
const mpConfig = (await import(resolve(ROOT, 'miniprogram/config.js'))).default;
check(
  mpConfig.enabled ? '允许联网时会去拉接口' : '禁止联网时不发任何请求',
  mpConfig.enabled ? wxRecord.requestCount > 0 : wxRecord.requestCount === 0,
  `实际 ${wxRecord.requestCount} 次（config.enabled=${mpConfig.enabled}）`
);

/* --------------------------- 2. 数据可渲染性 --------------------------- */

console.log('\n【2】setData 载荷可渲染性');

const payloadText = renders.map((p) => JSON.stringify(p)).join('\n');
const bad = [];
if (payloadText.includes('NaN')) bad.push('NaN');
if (payloadText.includes('undefined')) bad.push('undefined');
check('载荷中无 NaN / undefined', bad.length === 0, bad.join(', '));
check('确实产生了 setData 载荷', renders.length > 0, `${renders.length} 次`);

const d = page.data;

console.log('\n【3】滚动计时');
check('counter 有 4 组（天/时/分/秒）', Array.isArray(d.counter) && d.counter.length === 4, `实际 ${d.counter && d.counter.length}`);
check(
  '每组单位依次为 天/时/分/秒',
  d.counter.map((g) => g.unit).join('') === '天时分秒',
  d.counter.map((g) => g.unit).join('')
);
check(
  '每一组都是纯数字位',
  d.counter.every((g) => Array.isArray(g.digits) && g.digits.length >= 1 && g.digits.every((x) => /^[0-9]$/.test(x))),
  JSON.stringify(d.counter)
);
check('时/分/秒固定两位（防止宽度跳动）', d.counter.slice(1).every((g) => g.digits.length === 2), JSON.stringify(d.counter.slice(1)));
check('since 文案已生成并明确北京时间', typeof d.since === 'string' && d.since.startsWith('上次 ') && d.since.endsWith('北京时间'), d.since);
check('判定文案已生成', !!d.verdict.text && !!d.verdict.tail, JSON.stringify(d.verdict));

// 手动推进一秒，确认数字真的会变（滚动动画的前提）
const before = JSON.stringify(page.data.counter);
page.lastAt = page.lastAt - 1000; // 假装又过了一秒
page.tick();
const after = JSON.stringify(page.data.counter);
check('tick() 会更新数字（滚动有内容可动）', before !== after, `${before} → ${after}`);

// 再推进一整天，确认位数变化的边界（8 天 → 9 天）不会下标越界
page.lastAt = page.lastAt - 86400000;
page.tick();
check('天/时/分/秒进位后仍为纯数字位', page.data.counter.every((g) => g.digits.every((x) => /^[0-9]$/.test(x))), JSON.stringify(page.data.counter));

console.log('\n【4】指标与预测');
check('指标 6 项', d.metrics.length === 6, `实际 ${d.metrics.length}`);
check('指标无空值', d.metrics.every((m) => m.v !== '' && m.v != null && m.note), JSON.stringify(d.metrics));
check('预测已生成', !!d.forecast);

/* 详细区保留三张辅助卡，首屏则用三行来自真实预测与回测结果的数字摘要。 */
check(
  '依据区三张卡都在（多久 / 准不准 / 节奏）',
  !!d.forecast.wait && !!d.forecast.backtest && !!d.forecast.pace,
  Object.keys(d.forecast).join(',')
);
check(
  '节头副文案跟着档位换措辞（公告档别说「结论在上方」）',
  typeof d.forecast.hint === 'string' && d.forecast.hint.length > 8,
  d.forecast.hint
);

// —— 卡①：还要等多久 ——
check('概率条 5 条', d.forecast.wait.bars.length === 5, `实际 ${d.forecast.wait.bars.length}`);
check(
  '概率条宽度都在 1%–100%',
  d.forecast.wait.bars.every((b) => Number(b.w) >= 1 && Number(b.w) <= 100),
  JSON.stringify(d.forecast.wait.bars.map((b) => b.w))
);
check('中位剩余主数字为纯数字', /^[0-9]+$/.test(d.forecast.wait.num), d.forecast.wait.num);
check(
  '中位剩余带时长单位（不再是光秃秃的「天」）',
  /^(天|小时|分|秒)( \d+ (小时|分|秒))?$/.test(d.forecast.wait.unit),
  d.forecast.wait.unit
);
check(
  '80% 区间两端都按时长格式渲染（且带「80% 区间」前缀）',
  d.forecast.wait.range.startsWith('80% 区间 ') &&
    d.forecast.wait.range
      .slice('80% 区间 '.length)
      .split(' – ')
      .length === 2 &&
    d.forecast.wait.range
      .slice('80% 区间 '.length)
      .split(' – ')
      .every((s) => /^\d+ (天|小时|分|秒)( \d+ (小时|分|秒))?$/.test(s)),
  d.forecast.wait.range
);
// 概率没做过校准这件事必须在**数字旁边**说，不能用散文代替 ——
// 它报的不是系统有多好，而是这些数字偏低。掉这句，卡上就只剩一串看着可信的数。
check(
  '概率条旁边留着「未经校正」的提示',
  typeof d.forecast.wait.warn === 'string' && /未经校正/.test(d.forecast.wait.warn),
  d.forecast.wait.warn
);

// —— 卡②：准不准 ——
// 四行不是三行：样本量看标题、覆盖率 / 区分度 / **重采样波动** 三行。
// 第四行不能省 —— 它与覆盖率、样本量一起直接决定主卡那个置信度，
// 而卡底那句结语正是拿它们三个当主语的。少一行，那句话就指着页面上看不见的东西说话。
check('回测表 4 行', d.forecast.backtest.rows.length === 4, `实际 ${d.forecast.backtest.rows.length}`);
check(
  '回测表四行依次是 50%分位 / 80%区间 / 区分度 / 重采样波动',
  d.forecast.backtest.rows.map((r) => r.k).join('|') ===
    '50% 分位覆盖率|80% 区间覆盖率|7 天区分度|重采样波动',
  d.forecast.backtest.rows.map((r) => r.k).join('|')
);
check(
  '每一行都带「过没过」之外的说明（判据要能读，不能只给个红绿点）',
  d.forecast.backtest.rows.every((r) => typeof r.j === 'string' && r.j.length > 0),
  JSON.stringify(d.forecast.backtest.rows.map((r) => r.j))
);
check(
  '样本量标题带阈值（读者要知道「≥ 多少才算够」）',
  Number.isFinite(Number(d.forecast.backtest.n)) && Number.isFinite(Number(d.forecast.backtest.minN)),
  `n=${d.forecast.backtest.n} minN=${d.forecast.backtest.minN}`
);

/* 卡底那句结语里的「N 项未达标」必须与**同一张卡上看得见的判据**自洽：
   样本量（n ≥ minN）、覆盖率（第 2 行）、重采样波动（第 4 行）。
   ⚠ 第 1 行（50% 分位覆盖率）与第 3 行（7 天区分度）**不在**这句话的主语里 ——
   把它们算进去会把 N 说大。
   这条是「同源」断言：结语若来自本地另拼的一份模板，等式就会破。 */
{
  const bt = d.forecast.backtest;
  const failed = [
    Number(bt.n) >= Number(bt.minN),
    !!bt.rows[1].ok,
    !!bt.rows[3].ok,
  ].filter((ok) => !ok).length;
  const note = String(bt.note ?? '');
  check(
    '卡②结语的「N 项未达标」与卡上那三个判据自洽',
    note.length > 8 && (failed === 0 ? /都在容差内/.test(note) : new RegExp(`有 ${failed} 项未达标`).test(note)),
    `failed=${failed} / note=「${note}」`
  );
}

// —— 卡③：节奏在往哪走 ——
check('阶段表非空', d.forecast.pace.phases.length >= 2, `实际 ${d.forecast.pace.phases.length}`);
check(
  '阶段表日期已格式化（不是 ISO 原文）',
  d.forecast.pace.phases.every((p) => /^\d{4}\.\d{2}\.\d{2}$/.test(p.from) && /^\d{4}\.\d{2}\.\d{2}$/.test(p.to)),
  JSON.stringify(d.forecast.pace.phases[0])
);
check(
  '阶段表每段有编号（页面靠它画从左到右的箭头）',
  d.forecast.pace.phases.every((p, i) => p.i === i + 1),
  JSON.stringify(d.forecast.pace.phases.map((p) => p.i))
);

/* ---- 4b. 预测总览：首屏第一块，四个问题缺一不可 ---- */

// 这一块的断言盯的是「四个问题都答了没有」，不是字段名对不对。
// 用户进页面第一眼要知道的四件事：下一次什么时候 / 可不可信 / 凭什么 / 还有多久。
// 缺任何一条，首屏就退回「观察站」—— 而那正是这次改版要修正的问题。
const ov = d.pred;
check('预测总览已生成（带推断的那块）', !!ov, JSON.stringify(ov));
check(
  '日期用逐位数组呈现，值与真实预测日期一致',
  Array.isArray(ov.dateDigits) && ov.dateDigits.map((digit) => digit.value).join('') === ov.md,
  `${ov.md} / ${(ov.dateDigits || []).map((digit) => digit.value).join('')}`
);
check('日期圆点有独立窄位可供排版', ov.dateDigits.some((digit) => digit.value === '.') && ov.dateDigits.every((digit) => digit.key && digit.delay), JSON.stringify(ov.dateDigits));
check(
  '① 下一次什么时候：日期 + 星期 + 时刻三件都在',
  /^\d{1,2}\.\d{1,2}$/.test(ov.md) && /^周[一二三四五六日]$/.test(ov.wd) && /^\d{2}:\d{2}$/.test(ov.hm),
  `${ov.md} ${ov.wd} ${ov.hm}`
);
check('① 的倒计时锚点是个能算的时间戳', Number.isFinite(ov.etaAt), String(ov.etaAt));
check(
  '② 可不可信：状态（依据从哪来）+ 置信度（这个来源值多少分）是两个轴',
  !!ov.statusLabel && !!ov.statusNote && ['high', 'medium', 'low'].includes(ov.confidence),
  `${ov.statusLabel} / ${ov.confidenceLabel}(${ov.confidence})`
);
check(
  '② 置信度有条宽可画（0 < w ≤ 100）',
  Number.isFinite(ov.confidenceW) && ov.confidenceW > 0 && ov.confidenceW <= 100,
  `${ov.confidenceW}%`
);
check('③ 凭什么：一句话依据摘要', typeof ov.brief === 'string' && ov.brief.length > 8, ov.brief);
check(
  '③ 依据摘要的字面必须分档（无公告说「没有公告」，有公告说「已给出公告」）',
  ov.etaKind === 'announced' ? /已给出公告/.test(ov.brief) : /没有公告/.test(ov.brief),
  `${ov.etaKind} → ${ov.brief}`
);
check(
  '区间/窗口的**标签**跟着档位走（公告窗口不能叫成 80% 区间）',
  !!ov.band && (ov.bandLabel === '公告窗口') === (ov.etaKind === 'announced'),
  `${ov.etaKind} → ${ov.bandLabel} ${ov.band}`
);
check(
  '④ 元信息：预测算于（含北京时间）',
  /\d{2}\.\d{2} \d{2}:\d{2}/.test(ov.updatedText),
  ov.updatedText
);

{
  const rows = d.basisRows;
  const coverage = d.forecast.backtest.rows.find((row) => row.k === '80% 区间覆盖率');
  const phase = d.forecast.pace.phases[d.forecast.pace.phases.length - 1];
  const announcedParts = [];
  if (ov.briefData.announcedHard > 0) announcedParts.push(`${ov.briefData.announcedHard} 条硬承诺`);
  if (ov.briefData.announcedSoft > 0) announcedParts.push(`${ov.briefData.announcedSoft} 条同日提及`);
  const sourceValue = ov.etaKind === 'announced'
    ? announcedParts.join(' · ') || '公告窗口已确认'
    : `${ov.briefData.intervals} 次间隔`;
  check('首屏保留三行真实预测依据摘要', rows.length === 3, JSON.stringify(rows));
  check('依据摘要的来源行与当前预测模式一致', rows[0].value === sourceValue, `${rows[0].value} / ${sourceValue}`);
  check('覆盖率行复用回测的 80% 区间值', rows[1].value === coverage.v, `${rows[1].value} / ${coverage.v}`);
  check('近期节奏行复用最新分段均值', rows[2].value === `${phase.mean}${phase.unit.replace(/\s+/g, '')}`, rows[2].value);
}
check(
  '总览里没有 undefined / NaN',
  !JSON.stringify(ov).includes('undefined') && !JSON.stringify(ov).includes('NaN'),
  JSON.stringify(ov).slice(0, 160)
);

/* ⚠ 下一条是**值**断言，不是形状断言。
   `rangeText` 曾经取 q25–q90 而标成「80% 区间」—— 格式完全合法，
   所以上面那条形状断言照样绿，错的只是那两个端点。双侧 80% 区间是 [q10, q90]。
   用快照自己的数字重算一遍来核对，而不是把当前值写死。 */
const snapPred = (await import(resolve(ROOT, 'miniprogram/data/snapshot.js'))).default.prediction;
const fmt = await import(resolve(ROOT, 'miniprogram/utils/format.js'));
const { pct1, fmtSpan } = fmt;
// ⚠ 期望值要用**与 view.js 同一个** `fmtSpan` 算，早先是拿 scene.js 的 `fmtSpanShort`。
// 两条实现是刻意分开的（网页端 `render.mjs` 的 `spanOf` 是权威、`scene.js` 只给短串），
// 拿短串来核对长串，等于顺手把「两份口径漂了」这件事也放过去了。
const wantRange = `80% 区间 ${fmtSpan(snapPred.prediction.q10)} – ${fmtSpan(snapPred.prediction.q90)}`;
check(
  '80% 区间的端点是 q10–q90（不是 q25–q90）',
  d.forecast.wait.range === wantRange,
  `实得「${d.forecast.wait.range}」/ 期望「${wantRange}」`
);
// 非恒真守卫：两个端点真的不同，否则上一条可能是「怎么写都过」
check(
  'q10 与 q25 确实是两个不同的端点（证明上一条不是恒真）',
  snapPred.prediction.q10 !== snapPred.prediction.q25,
  `q10=${snapPred.prediction.q10} q25=${snapPred.prediction.q25}`
);
// 回测表那一行的**口径**：它论证的是上面那个双侧区间，所以必须是 covBand80。
// 用 cov80 也能填出一个看着像样的百分比 —— 换个口径讲另一件事，是最难发现的那类错。
{
  const row = d.forecast.backtest.rows[1];
  check(
    '回测表的「80% 区间覆盖率」行取的是 covBand80（双侧），不是 cov80（单侧上界）',
    row.k === '80% 区间覆盖率' && row.v === pct1(snapPred.calibration.covBand80),
    `${row.k} = ${row.v} / covBand80 = ${pct1(snapPred.calibration.covBand80)}`
  );
}
// 第四行的**值**也要对得上：它是 outlook 判据 `relOk` 的原料，页面上少这一个数，
// 置信度就少一个可核对的理由。阈值取自 outlook 自己的常量区间（≤ 1.5×）。
check(
  '回测表第四行「重采样波动」的值带 × 单位（不是光秃秃的倍数）',
  /^(\d+\.\d+×|—)$/.test(d.forecast.backtest.rows[3].v),
  d.forecast.backtest.rows[3].v
);

/* ---- 4c. 总览的倒计时：与公告倒计时是两个锚点 ---- */

check(
  'tick() 之后总览的倒计时已挂上（否则首屏那一块是空的）',
  !!page.data.pred.cd && Array.isArray(page.data.pred.cd.groups) && page.data.pred.cd.groups.length === 2,
  JSON.stringify(page.data.pred.cd)
);
check(
  '倒计时只显示相邻的最高两组单位',
  ['天时', '时分', '分秒'].includes((page.data.pred.cd.groups || []).map((g) => g.unit).join('')),
  JSON.stringify(page.data.pred.cd.groups)
);
// 去重：同一秒内重复 tick 不该再发一次 setData。整块卡片随倒计时重排会掉帧，
// 所以这条不是「优化」，是首屏流畅度的前提。
{
  const n0 = renders.length;
  page.tick();
  page.tick();
  check('同一秒内不重复推送倒计时（避免整块重排）', renders.length === n0, `多推了 ${renders.length - n0} 次`);
}

{
  const { predCountdown } = await import(resolve(ROOT, 'miniprogram/utils/view.js'));
  const anchor = 1_000_000;
  const units = (delta) => predCountdown({ etaAt: anchor + delta, etaKind: 'model' }, anchor).groups.map((g) => g.unit).join('');
  check('超过一天显示天/小时', units(26 * 3600_000) === '天时', units(26 * 3600_000));
  check('一小时以上显示小时/分钟', units(90 * 60_000) === '时分', units(90 * 60_000));
  check('不足一小时显示分钟/秒', units(30 * 60_000) === '分秒', units(30 * 60_000));
}
// 过点之后的措辞必须分档：公告档不能说「已到中位预测时刻」—— 那时根本没有中位预测。
// 直接喂一个「已经过点」的 ETA，而不是等它真的过期（那要等到数据换代）。
let overModelLabel = '';
let overAnnLabel = '';
{
  const realEta = page.data.pred.etaAt;
  const realKind = page.data.pred.etaKind;
  const nowMs = Date.now();
  page.data.pred.etaAt = nowMs - 60_000;

  page.data.pred.etaKind = 'model';
  page._pcdKey = null;
  const overModel = page.tickPredCountdown(nowMs);
  overModelLabel = (overModel && overModel.label) || '';
  check(
    '过了 ETA：算推档说「已到中位预测时刻」',
    !!overModel && overModel.over === true && /已到中位预测时刻/.test(overModelLabel),
    overModelLabel
  );

  page.data.pred.etaKind = 'announced';
  page._pcdKey = null;
  const overAnn = page.tickPredCountdown(nowMs);
  overAnnLabel = (overAnn && overAnn.label) || '';
  check(
    '过了 ETA：公告档说「公告窗口已开启」，且不提「中位」',
    !!overAnn && overAnn.over === true && /公告窗口已开启/.test(overAnnLabel) && !/中位/.test(overAnnLabel),
    overAnnLabel
  );

  page.data.pred.etaAt = realEta;
  page.data.pred.etaKind = realKind;
  page._pcdKey = null;
  page.tickPredCountdown(nowMs);
}
// 非恒真守卫：两档如果给出同一句话，说明分档没生效，上面两条也就退化成同一条。
check(
  '两档的过点措辞确实不同（证明「分档」这条断言不是恒真）',
  overModelLabel !== '' && overAnnLabel !== '' && overModelLabel !== overAnnLabel,
  `model=「${overModelLabel}」/ announced=「${overAnnLabel}」`
);
check(
  '还没到 ETA 时说的是「预计还需等待」',
  /预计还需等待/.test(page.data.pred.cd.label),
  page.data.pred.cd.label
);

console.log('\n【5】信号');

// 断言必须从数据推出，不能写死 —— 否则收录到一条真的预告后这条用例就假失败
const snapshotSignals = (await import(resolve(ROOT, 'miniprogram/data/snapshot.js'))).default.signals;

// 期望值与 buildSignal 的优先级同构：预告（有窗口）> 线索（须有窗口）。
// 「已发生」不参与横幅 —— 它是往回看的事实，横幅只讲未来。见 【8b】。
// 预告的判据从 `signals` 换成 `forecasts`：合并下沉到数据层之后，
// 横幅认的是「一个时间窗口一条预告」（见 decisions.md 的 D-018）。
const hasForecast = (snapshotSignals.forecasts || []).length > 0;
const hasOccurred = (snapshotSignals.occurred || []).length > 0;
const hasHintWin = (snapshotSignals.hints || []).some((s) => s.window);
const expectShow = hasForecast || hasHintWin;

check('信号对象存在', !!d.signal);
check(
  '醒目态与数据一致（预告 > 线索，不含已发生）',
  d.signal.show === expectShow,
  `show=${d.signal.show} 期望=${expectShow}（level=${snapshotSignals.level} occurred=${hasOccurred}）`
);
// 这一条是本轮的回归点：数据里明明有 2 条已发生的重置，但它不该把横幅顶起来 ——
// 顶上首页的是「距上次重置 N 天」，不是复述一遍那段事实。
if (hasOccurred && !hasForecast && !hasHintWin) {
  check(
    '已发生的重置不进横幅（数据里有，横幅里没有）',
    d.signal.show === false,
    `occurred=${(snapshotSignals.occurred || []).length} 但 show=${d.signal.show} level=${d.signal.level}`
  );
}
if (expectShow) {
  check('醒目态必须给出时间窗口', !!d.signal.window, JSON.stringify(d.signal.window));
  check('窗口含双时区', !!(d.signal.window && d.signal.window.sourceZone && d.signal.window.userZone), JSON.stringify(d.signal.window));
  check('窗口含时差说明', !!(d.signal.window && d.signal.window.diffText), d.signal.window && d.signal.window.diffText);
  check('给出判定依据（不只给结论）', !!d.signal.reason, d.signal.reason);

  if (hasForecast) {
    // 本轮的核心结构：**一条预告，里面 N 条推文**。
    // 旧版把同一件事拆成「横幅（只挂最新一条原文）+ 另起一行计数 + 独立摘要块」，
    // 端上要在三处之间自己拼归属关系。
    check('预告里挂着依据推文', d.signal.evCount >= 1, `实际 ${d.signal.evCount}`);
    check(
      '依据条数与数据层一致（不各算各的）',
      d.signal.evCount === snapshotSignals.forecasts[0].evidence.length,
      `${d.signal.evCount} vs ${snapshotSignals.forecasts[0].evidence.length}`
    );
    check('依据默认收起（一屏放不下「窗口 + 推文 + 倒计时」）', d.signal.evOpen === false, String(d.signal.evOpen));
    check(
      '每条依据都带：北京时间 / 承诺或提及 / 原文 / 原推链接',
      d.signal.ev.length > 0 &&
        d.signal.ev.every(
          (e) => /^\d{2}\.\d{2} \d{2}:\d{2}$/.test(e.when) && e.tag && e.text && e.url
        ),
      JSON.stringify(d.signal.ev[0] || {})
    );
    check(
      '权重取值只有 hard / soft（渲染层据此分色）',
      d.signal.ev.every((e) => e.weight === 'hard' || e.weight === 'soft'),
      d.signal.ev.map((e) => e.weight).join(',')
    );
    check('摘要行说清构成（承诺几条、同日提及几条）', d.signal.evMix.includes('承诺'), d.signal.evMix);
    check('没有依据可挂时不会渲染空的依据块', d.signal.ev.length === 0 || !!d.signal.evMix, String(d.signal.ev.length));
  } else {
    // 线索形态：单条推文 + 它的窗口，没有证据链
    check('线索形态：给出原文', !!d.signal.text, d.signal.text);
    check('线索形态：没有依据列表（不渲染空块）', d.signal.evCount === 0, String(d.signal.evCount));
    check('线索形态：给出发布时刻（双时区）', d.signal.createdText.includes('北京') && d.signal.createdText.includes('当地'), d.signal.createdText);
  }
} else {
  check('空闲态给出扫描条数', Number.isFinite(d.signal.checked) && d.signal.checked > 0, String(d.signal.checked));
  check('空闲态不显示时间窗口', !d.signal.window, JSON.stringify(d.signal.window));
  // 真实数据下的即时防线（合成输入的完整覆盖见第 11 节）
  check(
    '空闲态时间窗起点是日期而非 ISO 机器串',
    d.signal.windowFrom === '' || /^\d{4}\.\d{2}\.\d{2}$/.test(d.signal.windowFrom),
    d.signal.windowFrom
  );
}

console.log('\n【6】顶栏与页脚');
check('updText 已生成', typeof d.updText === 'string' && d.updText.length > 0, d.updText);
check('genText 是北京时间格式', /^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}$/.test(d.genText), d.genText);
check('降级时给出明示（不假装是实时数据）', d.degraded === true && d.notice.length > 0, d.notice);

/* --------------------------- 7. 图表几何越界 --------------------------- */

console.log('\n【7】图表几何（多个屏幕宽度）');

const { buildChartData } = await import(resolve(ROOT, 'src/lib/chart-data.js'));
const { survivalScene, stripScene, rhythmScene, sceneBounds } = await import(resolve(ROOT, 'src/lib/scene.js'));

const records = JSON.parse(await readFile(resolve(ROOT, 'data/resets.json'), 'utf8')).records;
const chart = buildChartData(records, Date.now());

const WIDTHS = [320, 341, 375, 414];
const SIZES = [
  { name: '生存曲线', fn: survivalScene, height: 208 },
  { name: '点阵分布', fn: stripScene, height: 230 },
  { name: '近七次历史节奏', fn: rhythmScene, height: 160 },
];

for (const w of WIDTHS) {
  for (const s of SIZES) {
    const scene = s.fn(chart, { layout: 'compact', width: w, height: s.height });
    const b = sceneBounds(scene);
    const okX = b.minX >= -0.5 && b.maxX <= w + 0.5;
    const okY = b.minY >= -0.5 && b.maxY <= s.height + 0.5;
    check(
      `${w}px · ${s.name} 在画布内`,
      okX && okY,
      `x=[${b.minX.toFixed(1)}, ${b.maxX.toFixed(1)}] y=[${b.minY.toFixed(1)}, ${b.maxY.toFixed(1)}]`
    );
    check(`${w}px · ${s.name} 元素非空`, scene.elements.length > 20, `${scene.elements.length} 个图元`);
  }
}

// 双端一致性：同一份数据在宽布局与紧凑布局下，必须给出同一个「当前百分位」
const wide = survivalScene(chart, {});
const compact = survivalScene(chart, { layout: 'compact', width: 341 });
const pctOf = (scene) => {
  const t = scene.elements.find((e) => e.k === 'text' && /^现在 · /.test(e.s));
  return t ? t.s : null;
};
check('宽/紧凑两种布局给出同一个当前百分位', pctOf(wide) === pctOf(compact), `${pctOf(wide)} vs ${pctOf(compact)}`);

const rhythm = rhythmScene(chart, { width: 341, height: 160 });
const rhythmLine = rhythm.elements.find((el) => el.k === 'poly' && el.stroke === '#6150d4');
check(
  '近七次节奏只使用最近七段完整间隔',
  !!rhythmLine && rhythmLine.pts.length === Math.min(7, chart.gapDays.length),
  `输入 ${chart.gapDays.length} 段 / 折线 ${rhythmLine ? rhythmLine.pts.length : 0} 点`
);

/* --------------------------- 8. 明确信号路径 --------------------------- */

console.log('\n【8】明确信号路径（合成推文 —— 平时真实数据里触发不到）');

const { detectSignals } = await import(resolve(ROOT, 'src/lib/signals.mjs'));
const { buildSignal } = await import(resolve(ROOT, 'miniprogram/utils/view.js'));

const now = Date.parse('2026-09-20T10:00:00.000Z'); // 北京 18:00
const mkTweet = (text, id) => ({
  id,
  account: 'thsottiaux',
  text,
  created_at: new Date(now - 3600_000).toISOString(),
});

const explicitSig = detectSignals(
  [mkTweet('We heard you. To celebrate, we are going to reset usage limits for everyone next Tuesday.', '9001')],
  { now, account: 'thsottiaux' }
);
check('合成推文被判为明确信号', explicitSig.level === 'explicit', explicitSig.level);

const vm = buildSignal(explicitSig);
check('横幅进入醒目态', vm.show === true && vm.level === 'explicit', `show=${vm.show} level=${vm.level}`);
check('明确信号必须给出时间窗口', !!vm.window);
check('窗口含 Tibo 当地时间', !!(vm.window && vm.window.sourceZone), vm.window && vm.window.sourceZone);
check('窗口含北京时间', !!(vm.window && vm.window.userZone), vm.window && vm.window.userZone);
check('窗口含两个时区的 UTC 偏移', !!(vm.window && vm.window.srcOffset && vm.window.usrOffset), JSON.stringify(vm.window));
check('窗口标注时差', !!(vm.window && vm.window.diffText), vm.window && vm.window.diffText);
// explicit 形态的「发布时刻」由**依据推文**承担 —— 横幅本身就是这几条推文的合并，
// 再在页脚复述一次就是重复。时间一律北京时间（旧版这里贴的是 UTC，同一条推文
// 在页面上会有两个相差 8 小时的时间戳）。
check(
  '依据推文带北京时间（旧版此处贴的是 UTC）',
  vm.ev.length === 1 && /^\d{2}\.\d{2} \d{2}:\d{2}$/.test(vm.ev[0].when),
  JSON.stringify(vm.ev[0] || {})
);
check('合成推文 → 一条预告，里面 1 条推文', vm.evCount === 1, `实际 ${vm.evCount}`);
check('合成推文的依据也带权重（承诺）', vm.ev[0] && vm.ev[0].weight === 'hard', JSON.stringify(vm.ev[0] || {}));
check('依据默认收起（手机一屏放不下）', vm.evOpen === false, String(vm.evOpen));
check('给出判定依据', !!vm.reason, vm.reason);
check(
  '视图模型里没有 undefined / NaN',
  !JSON.stringify(vm).includes('undefined') && !JSON.stringify(vm).includes('NaN'),
  JSON.stringify(vm).slice(0, 120)
);

/* ---- 窄屏断行：尾部那个词不许落单 ---- */

// 真机（402pt）上 `2026.09.22（周二）15:00 起` 整串放不下（约需 352rpx，可用只有 313rpx），
// 而它**只有一个空格**（在 `15:00` 后），`word-break: keep-all` 又禁止汉字间断行 ——
// 于是唯一的那个断点被用上，「起」孤零零一行。
// 修法不是挤宽度（差 39rpx，挤到了也经不起字体渲染差异），而是把断点显式放到要断的位置。
const { breakBeforeTime } = await import(resolve(ROOT, 'miniprogram/utils/view.js'));

check(
  '日期+时间：断点显式落在时间前（就是真机实测那个值）',
  breakBeforeTime('2026.09.22（周二）15:00 起') === '2026.09.22（周二）\n15:00 起',
  JSON.stringify(breakBeforeTime('2026.09.22（周二）15:00 起'))
);
check(
  '日期与时间之间本来有空格时，仍断成同样两行',
  breakBeforeTime('2026.09.22（周二） 15:00 起') === '2026.09.22（周二）\n15:00 起',
  JSON.stringify(breakBeforeTime('2026.09.22（周二） 15:00 起'))
);
check(
  '没有时间的值一个字都不动（它本来就放得下）',
  breakBeforeTime('2026.09.22（周二） 全天') === '2026.09.22（周二） 全天'
);
check('已含换行的值幂等（不会插第二个）', breakBeforeTime('a\n15:00 起') === 'a\n15:00 起');
check('时间在最前面、前面没内容：不动（否则首行会是空的）', breakBeforeTime('15:00 起') === '15:00 起');
check(
  '多个时间：只断第一个',
  breakBeforeTime('09.22 15:00 起 19:00 止') === '09.22\n15:00 起 19:00 止',
  JSON.stringify(breakBeforeTime('09.22 15:00 起 19:00 止'))
);
check('非字符串：原样返回', breakBeforeTime(null) === null && breakBeforeTime(undefined) === undefined);

// 集成点：windowView 必须真的调它。少了这一条，上面的纯函数单测在
// 「调用被删掉」时照样全绿 —— 而孤字会原样回来。
const viewSrc = await readFile(resolve(ROOT, 'miniprogram/utils/view.js'), 'utf8');
check(
  'windowView 对两行时区值都过 breakBeforeTime',
  /sourceZone:\s*breakBeforeTime\(/.test(viewSrc) && /userZone:\s*breakBeforeTime\(/.test(viewSrc),
  '调用点被删了'
);

// 反例：有额度词但通篇没有任何时间表达 —— 不得进醒目态（否则就是制造焦虑）
const noTimeSig = detectSignals([mkTweet('We are reviewing usage limits across all plans.', '9002')], { now });
check('该推文确实没有解析出时间窗口', !noTimeSig.hints.some((h) => h.window), JSON.stringify(noTimeSig.hints.map((h) => h.window)));
check(
  '有额度意图但无时间窗口时，不进醒目态',
  buildSignal(noTimeSig).show === false,
  `show=${buildSignal(noTimeSig).show} level=${noTimeSig.level}`
);

// 边界：带「this week」这类模糊时间只能算线索，不得升格为明确信号
const vagueSig = detectSignals([mkTweet('We are actively looking at usage limits this week.', '9004')], { now });
check(
  '模糊时间（this week）只能作线索，不得升格为明确信号',
  vagueSig.level !== 'explicit',
  `level=${vagueSig.level}`
);
check('模糊时间下横幅标为「线索」', buildSignal(vagueSig).badge === '线索' || buildSignal(vagueSig).show === false, JSON.stringify(buildSignal(vagueSig).badge));

// 反例：有未来时间但讲的是发布延期 —— 不得进醒目态
const launchSig = detectSignals([mkTweet('We are delaying the launch until next Tuesday.', '9003')], { now });
check(
  '「发布延期」不被误报成重置预告',
  buildSignal(launchSig).show === false,
  `show=${buildSignal(launchSig).show} level=${launchSig.level}`
);

// buildSignal 的契约：线索带窗口 → 展示但标为「线索」；线索无窗口 → 不展示
const W = {
  sourceZone: '2026.09.22（周二）全天',
  userZone: '2026.09.23（周三）全天',
  zones: { a: { offset: 'UTC+8' }, b: { offset: 'UTC-7' } },
  diffText: '北京时间比 Tibo 当地时间快 15 小时',
};
const hintWithWin = buildSignal({
  level: 'hint',
  checkedTweets: 5,
  lookbackDays: 60,
  hints: [{ level: 'hint', window: W, text: 't', precision: 'day', reasons: ['含未来语气'] }],
});
check('线索带窗口时展示，但标为「线索」而不是「明确信号」', hintWithWin.show && hintWithWin.badge === '线索', JSON.stringify(hintWithWin.badge));

const hintNoWin = buildSignal({
  level: 'hint',
  checkedTweets: 5,
  lookbackDays: 60,
  hints: [{ level: 'hint', window: null, text: 't', reasons: [] }],
});
check('线索无窗口时不展示（不放没有时间的空话）', hintNoWin.show === false);

/* ------------- 8b. 「已发生」：识别保留，但不进横幅 ------------- */

/*
 * 两个层次必须分开看：
 *   ① **识别层** —— 已经发生的重置要被认出来。旧实现把它判成「已完成的过去事件，
 *      不是预告」直接丢掉，于是数据里根本看不见 09-12 那次重置。这条回归保留。
 *   ② **呈现层** —— 认出来之后**不在页首列举**。横幅回答的是「下一次什么时候」，
 *      而「已发生」是往回看的事实，它的载体是首页顶部的「距上次重置 N 天」与
 *      重置历史页。再在页首铺卡片，既把倒计时挤出首屏，也只是复述同一件事。
 */

const occurredTweets = [
  {
    id: '9101',
    account: 'thsottiaux',
    text: 'Reset all propagated. Sweet dreams.',
    created_at: '2026-09-12T08:09:17.000Z',
  },
  {
    id: '9102',
    account: 'thsottiaux',
    text: '11pm on a Tuesday, big startup energy',
    created_at: '2026-09-16T07:14:19.000Z',
  },
];
const occSig = detectSignals(occurredTweets, { now });
check('已发生的重置被识别出来（识别层保留）', occSig.occurred.length === 1, `实际 ${occSig.occurred.length}`);
check('汇总等级为 occurred', occSig.level === 'occurred', occSig.level);
check(
  '与额度无关的推文不会被算进已发生',
  !occSig.occurred.some((x) => x.id === '9102'),
  occSig.occurred.map((x) => x.id).join(',')
);

const occVm = buildSignal(occSig);
check(
  '已发生不进横幅（不在页首列举既成事实）',
  occVm.show === false,
  `show=${occVm.show} level=${occVm.level}`
);
check(
  '不进横幅时仍给空闲态字段（扫描条数不丢）',
  Number.isFinite(occVm.checked) && occVm.checked > 0,
  String(occVm.checked)
);

// 预告优先：两者并存时，前景该是「下一次什么时候」（可行动），
// 而不是「刚发生过」（已是既成事实）。
const bothSig = detectSignals(
  [
    ...occurredTweets,
    mkTweet(
      'We heard you. To celebrate, we are going to reset usage limits for everyone next Tuesday.',
      '9005'
    ),
  ],
  { now }
);
check('预告与已发生并存时，汇总等级取 explicit', bothSig.level === 'explicit', bothSig.level);
check(
  '并存时横幅取预告（可行动的那条）',
  buildSignal(bothSig).badge === '明确信号',
  buildSignal(bothSig).badge
);

/* ------------- 8c. 每日重置窗口：跨多日的规则，与横幅解耦 ------------- */

/**
 * 他宣布「未来 N 天里每天要么发一个改进、要么给一次完整重置」（实测 2026-10-04）。
 *
 * 这块**不能挂在横幅那道门里**：横幅回答「有没有某一天的预告」，
 * 而这条规则讲的是「这 N 天里每一天都在射程内」。只在预告分支里带上它，
 * 等于「没有预告时这条规则也不存在」—— 而那恰恰是最需要它的时候
 * （没有预告 + 还有 26 天 = 读者最容易以为「这段时间不会重置」）。
 * 所以下面逐条钉死：三条返回路径都必须带上它。
 */
const progTweet = mkTweet(
  'Over the next 28 days, each day we’ll either ship one thing that is a clear improvement and relevant for most codex/work users or ship a full reset. Let the improvements begin.',
  '9101'
);
const progSig = detectSignals([progTweet], { now });
check('每日重置窗口被识别出来', Boolean(progSig.program), JSON.stringify(progSig.program));
check('窗口天数取自原文（28）', progSig.program?.days === 28, String(progSig.program?.days));
check('剩余天数是整数且落在区间内', Number.isInteger(progSig.program?.daysLeft) && progSig.program.daysLeft > 0 && progSig.program.daysLeft <= 28, String(progSig.program?.daysLeft));

const progVm = buildSignal(progSig);
check('端上带出每日重置窗口', progVm.program?.show === true, JSON.stringify(progVm.program));
check('窗口块有当地/北京两行（复用 windowView）', Boolean(progVm.program?.window?.sourceZone && progVm.program?.window?.userZone), JSON.stringify(progVm.program?.window));
/* 宣布时刻也必须是**双时区**，而且文本来自数据层（`buildProgram` 的 createdZones），
 * 端点只拼不改 —— 端上自己换算要依赖 Intl，部分安卓机型不可用。
 * 钉完整串而不是「含『当地』」：窗口块里本来就有「当地」，那种断言是恒绿。 */
check(
  '宣布时刻双时区且由数据层带出（端上不自算）',
  progVm.program?.announcedText === '2026.09.20（周日）17:00 北京 · 2026.09.20（周日）02:00 当地',
  JSON.stringify(progVm.program?.announcedText)
);
check('数据层确实给了 createdZones（不是渲染层兜的）', Boolean(progSig.program?.createdZones?.a?.text && progSig.program?.createdZones?.b?.text), JSON.stringify(progSig.program?.createdZones));

// ① 空态路径（没有预告、没有线索）：规则必须还在
check('没有预告时窗口仍在（空态路径）', progVm.program.show === true && progVm.show === false, `show=${progVm.show} program=${progVm.program?.show}`);

// ② 有线索的路径
const hintPathVm = buildSignal({
  ...progSig,
  hints: [{ id: 'h1', text: 'x', level: 'hint', window: { from: 'x', to: 'x' } }],
});
check('有线索时窗口也在', hintPathVm.program?.show === true, JSON.stringify(hintPathVm.program?.show));

// ③ 有预告的路径
const fcastPathVm = buildSignal({ ...progSig, forecasts: [{ level: 'explicit', window: null, evidence: [] }] });
check('有预告时窗口也在（两条互不遮蔽）', fcastPathVm.program?.show === true, JSON.stringify(fcastPathVm.program?.show));

// 反例：没有这条规则时必须安静，不能凭空造一个窗口
check('没有该字段时不展示（更不炸）', buildSignal({ checkedTweets: 1 }).program?.show === false);
check('sig 为 null 时不炸', buildSignal(null).program?.show === false);

// 过期即撤：整段走完之后不再出现（与「过期的预告不再展示」同一条原则）。
//
// ⚠ 这条推文必须**写得进扫描窗**才算数：`mkTweet` 固定 created_at = now-1h，
// 那样算出来的窗口永远是活的，断言会恒绿。所以显式造一条 40 天前的推文 ——
// 它在 60 天的回看窗内（进得了 list），而它的 28 天窗口早就走完了（09-07 就结束）。
const staleProg = detectSignals(
  [
    {
      id: '9102',
      account: 'thsottiaux',
      text: progTweet.text,
      created_at: new Date(now - 40 * 86400_000).toISOString(),
    },
  ],
  { now }
);
check('窗口走完后不再出现', staleProg.program === null, JSON.stringify(staleProg.program));
check('它确实被判过（不是被扫描窗挡掉）', staleProg.checkedTweets === 1, `checked=${staleProg.checkedTweets}`);

/* --------------------- 9. F9 一次性订阅提醒 --------------------- */

console.log('\n【9】F9 一次性订阅提醒');

const sub = await import(resolve(ROOT, 'miniprogram/utils/subscribe.js'));
const configMod = (await import(resolve(ROOT, 'miniprogram/config.js'))).default;
const TMPL = 'TMPL_TEST';

check('未配置模板 ID 时不显示入口（不摆一个点了没反应的按钮）', sub.subscribeAvailable() === false);
check(
  '入口文案说清「一次授权只能收到一次通知」',
  /一次/.test(sub.SCOPE_HINT) && /通知/.test(sub.SCOPE_HINT),
  sub.SCOPE_HINT
);

// 四种授权结果必须分开说 —— 用户能做的处理完全不同，笼统报「失败」等于没提示
check('accept → 成功', sub.classifySubscribeResult({ [TMPL]: 'accept' }, TMPL).ok === true);
check('reject → 提示是他自己点了拒绝', /拒绝/.test(sub.classifySubscribeResult({ [TMPL]: 'reject' }, TMPL).reason));
check('ban → 指向微信设置里的总开关', /设置/.test(sub.classifySubscribeResult({ [TMPL]: 'ban' }, TMPL).reason));
check('未知结果 → 不谎报成功', sub.classifySubscribeResult({}, TMPL).ok === false);

// 打开联网与模板 ID，走一遍完整链路
configMod.enabled = true;
configMod.subscribeTemplateId = TMPL;
check('配置齐备后入口可用', sub.subscribeAvailable() === true);

page.initRemind();
check(
  '入口显示且按钮文案为「下次重置时提醒我」',
  page.data.remind.show === true && page.data.remind.label === sub.ACTION_LABEL,
  JSON.stringify(page.data.remind.label)
);

let posted = null;
wxRecord.onRequest = (opts) => {
  posted = { url: opts.url, method: opts.method, data: opts.data };
  opts.success({ statusCode: 200, data: { ok: true } });
};

await page.onToggleRemind();
check('申请订阅时带上了模板 ID', wxRecord.subscribeCalls.slice(-1)[0] === TMPL, wxRecord.subscribeCalls.join(' | '));
check('走了一次 wx.login 换 code', wxRecord.loginCount > 0, String(wxRecord.loginCount));
check(
  '上报到 /api/subscribe（POST）',
  posted && /\/api\/subscribe$/.test(posted.url) && posted.method === 'POST',
  posted && `${posted.method} ${posted.url}`
);
check(
  '上报体含 code 与 templateId，且**不含 openid**',
  posted && !!posted.data.code && posted.data.templateId === TMPL && !('openid' in posted.data),
  JSON.stringify(posted && posted.data)
);
check('成功后按钮转为「已开启」', page.data.remind.state === 'on' && page.data.remind.tone === 'ok', JSON.stringify(page.data.remind));

// 拒绝分支：不该产生任何网络动作
wxRecord.subscribeVerdict = 'reject';
page.initRemind();
const loginBefore = wxRecord.loginCount;
const reqBefore = wxRecord.requestCount;
await page.onToggleRemind();
check('用户拒绝时不换 code、不上报', wxRecord.loginCount === loginBefore && wxRecord.requestCount === reqBefore);
check('用户拒绝时给出可操作提示', page.data.remind.tone === 'warn' && /拒绝/.test(page.data.remind.feedback), page.data.remind.feedback);
check('用户拒绝后状态仍是未开启', page.data.remind.state === 'idle');

// 授权成功但后端同步失败：微信侧已经计入一次授权，不能谎报成功骗用户再点一次
wxRecord.subscribeVerdict = 'accept';
wxRecord.onRequest = (opts) => opts.success({ statusCode: 503, data: { error: 'subscribe disabled' } });
page.initRemind();
await page.onToggleRemind();
check(
  '授权成功但同步失败 → 如实说「可能收不到」，不谎报成功',
  page.data.remind.state === 'on' && page.data.remind.tone === 'warn' && /同步/.test(page.data.remind.feedback),
  page.data.remind.feedback
);

// code 是一次性的：每次调用都必须重新 wx.login
const codes = [];
wxRecord.onRequest = (opts) => {
  codes.push(opts.data && opts.data.code);
  opts.success({ statusCode: 200, data: { ok: true } });
};
await sub.subscribeOnce();
await sub.subscribeOnce();
check('每次都重新 wx.login，不复用旧 code', codes.length === 2 && codes[0] !== codes[1], codes.join(' / '));

// 缺模板 ID 时应在本地就拦住，不去骚扰微信接口
configMod.subscribeTemplateId = '';
let blocked = false;
try {
  await sub.subscribeOnce();
} catch (err) {
  blocked = /模板/.test(err.message);
}
check('缺模板 ID 时本地报错，不调用微信接口', blocked);
configMod.subscribeTemplateId = TMPL;

wxRecord.onRequest = null;

/* ------------------------------ 10. 预告可视化 ------------------------------ */

const { countdown, countdownGroups } = await import(resolve(ROOT, 'miniprogram/utils/format.js'));
const { buildGauge } = await import(resolve(ROOT, 'miniprogram/utils/view.js'));

console.log('\n【10】预告倒计时 / 大字公告 / 等待进度尺');

{
  // 倒计时：页面靠 over 切换「距窗口开启」与「窗口已开启」两套文案
  const ahead = countdown(now + 2 * 3600_000 + 30_000, now);
  check(
    '未到窗口 → over=false 且时长正确',
    ahead.over === false && ahead.h === 2 && ahead.m === 0,
    `${ahead.h}h${ahead.m}m${ahead.s}s`
  );
  check('已过窗口 → over=true（文案要换）', countdown(now - 1000, now).over === true);
  check(
    '倒计时分组为 天/时/分/秒',
    countdownGroups(ahead).map((g) => g.unit).join('/') === '天/时/分/秒',
    countdownGroups(ahead).map((g) => g.v).join(':')
  );

  // 大字公告：星期必须能被单独摘出来 —— 它是这块视觉的主角
  const sigTue = detectSignals([mkTweet('We will reset all usage limits next Tuesday.', '9101')], { now });
  const vmTue = buildSignal(sigTue);
  check('合成预告判为明确信号', sigTue.level === 'explicit', sigTue.level);
  check('大字公告取到星期', vmTue.headline && vmTue.headline.big === '周二', vmTue.headline && vmTue.headline.big);
  check(
    '副行带日期与时段',
    !!(vmTue.headline && /^\d+\.\d+ ·/.test(vmTue.headline.sub)),
    vmTue.headline && vmTue.headline.sub
  );
  check(
    '窗口时间戳直通（倒计时依赖它）',
    typeof (vmTue.window && vmTue.window.fromTs) === 'number',
    String(vmTue.window && vmTue.window.fromTs)
  );

  // 进度尺：档位决定颜色，边界值不能含糊
  check('83% → hot', buildGauge({ pct: 0.83 }).cls === 'hot', buildGauge({ pct: 0.83 }).fill);
  check('70% 边界 → hot', buildGauge({ pct: 0.7 }).cls === 'hot');
  check('60% → warm', buildGauge({ pct: 0.6 }).cls === 'warm');
  check('20% → cool', buildGauge({ pct: 0.2 }).cls === 'cool');
  check('刻度文案带百分位', /83%/.test(buildGauge({ pct: 0.83 }).text), buildGauge({ pct: 0.83 }).text);
  check('无数据 → null（模板 wx:if 兜住）', buildGauge(null) === null);
  check(
    'pct 越界被夹到 0–100',
    buildGauge({ pct: 1.4 }).fill === '100.0' && buildGauge({ pct: -0.2 }).fill === '0.0',
    `${buildGauge({ pct: 1.4 }).fill} / ${buildGauge({ pct: -0.2 }).fill}`
  );
}

/* ---------------- 11. 空闲态的时间窗起点不许是机器格式 ---------------- */

console.log('\n【11】时间窗起点的格式化（真机曾显示 `2026-07-25T02:15:29.011Z`）');

{
  const { buildSignal } = await import(resolve(ROOT, 'miniprogram/utils/view.js'));
  const { toTs } = await import(resolve(ROOT, 'miniprogram/utils/format.js'));

  // 数据层给的是 ISO 串（原始值、可复核）。端上少了解析这一环，那一行就会
  // 把机器格式直接印出来 —— 真机截图实测，而且还长到把副行顶出卡片。
  // 这里用**合成输入**而不是真实数据：真实数据的窗口起点天天在变，
  // 拿它当断言基准，测试会自己过期。
  const idle = (windowFrom) =>
    buildSignal({ checkedTweets: 86, lookbackDays: 60, windowFrom });

  check(
    '线上真实形态：ISO 串 → 北京时间日期',
    idle('2026-07-25T02:15:29.011Z').windowFrom === '2026.07.25',
    idle('2026-07-25T02:15:29.011Z').windowFrom
  );
  check(
    '按北京切日期而非 UTC 切（UTC 18:30 已是北京次日）',
    idle('2026-07-25T18:30:00.000Z').windowFrom === '2026.07.26',
    idle('2026-07-25T18:30:00.000Z').windowFrom
  );
  check(
    '取不到 → 空串（模板 wx:if 挡住「时间窗自  起」）',
    ['', null, undefined, 'not-a-date'].every((v) => idle(v).windowFrom === ''),
    ['', null, undefined, 'not-a-date'].map((v) => JSON.stringify(idle(v).windowFrom)).join(' ')
  );

  // 反向：机器格式的三个特征字符一个都不许出现
  const PROBES = [
    '2026-07-25T02:15:29.011Z',
    '2026-12-31T16:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    '2026-07-25',
    '2026-07-25T02:15:29+08:00',
  ];
  const leaked = PROBES.map((v) => idle(v).windowFrom).filter(
    (out) => /[TZ-]/.test(out)
  );
  check(
    `${PROBES.length} 个输入均未泄漏机器格式（无 T / Z / 连字符）`,
    leaked.length === 0,
    leaked.join(' | ') || 'clean'
  );

  check(
    'toTs：数字直通、NaN 输入不抛异常',
    toTs(1753412129011) === 1753412129011 &&
      Number.isNaN(toTs(NaN)) &&
      Number.isNaN(toTs(undefined)) &&
      Number.isNaN(toTs(null)),
    String(toTs(1753412129011))
  );
}

/* -------------- 12. 复制原推链接：隐私接口，失败不许静默 -------------- */

console.log('\n【12】复制原推链接（隐私接口，失败必须有反馈）');

{
  const { copyFailText } = await import(resolve(ROOT, 'miniprogram/utils/clipboard.js'));

  const URL_OK = 'https://x.com/i/status/1234567890';

  const reset = () => {
    wxRecord.clipboard.length = 0;
    wxRecord.toasts.length = 0;
    wxRecord.clipboardFails = false;
    wxRecord.clipboardErr = null;
  };

  // 先确认这次改动没把正常复制弄坏
  reset();
  page.onCopySource({ currentTarget: { dataset: { url: URL_OK } } });
  check('成功：URL 进了剪贴板', wxRecord.clipboard[0] === URL_OK, JSON.stringify(wxRecord.clipboard));
  check('成功：提示「链接已复制」', wxRecord.toasts[0] === '链接已复制', JSON.stringify(wxRecord.toasts));

  // 横幅兜底：预告里条目没带 url 时，回退到 signal.url（这条行为是原有的）
  reset();
  page.data.signal = Object.assign({}, page.data.signal, { url: URL_OK });
  page.onCopySource({ currentTarget: { dataset: {} } });
  check('条目无 url 时回退到横幅主链接', wxRecord.clipboard[0] === URL_OK, JSON.stringify(wxRecord.clipboard));

  // 核心守位：这些形态此前会让点击变成「什么都不发生」——没有 toast、没有日志、
  // 界面上也不显示 URL，用户既复制不到也看不到。errMsg 文案为示意，判定看 errno。
  const FAILS = [
    ['用户拒绝授权', { errno: 104, errMsg: 'setClipboardData:fail user deny' }],
    ['隐私弹窗被拒', { errno: 103, errMsg: 'setClipboardData:fail user deny' }],
    ['未声明剪贴板', { errno: 112, errMsg: 'setClipboardData:fail api scope is not declared in the privacy agreement' }],
    ['未知失败', { errno: 1, errMsg: 'setClipboardData:fail' }],
    ['回调没给字段', {}],
    ['回调给 null', null],
  ];
  reset();
  wxRecord.clipboardFails = true;
  const silent = [];
  for (const [name, err] of FAILS) {
    wxRecord.toasts.length = 0;
    wxRecord.clipboardErr = err;
    page.onCopySource({ currentTarget: { dataset: { url: URL_OK } } });
    if (!wxRecord.toasts[0]) silent.push(name);
  }
  check(`${FAILS.length} 种失败形态都留下了提示（无静默）`, silent.length === 0, silent.join(' | ') || 'clean');

  // 文案要分对：能挽回的（用户拒绝）给指路，不能挽回的（没声明）别甩锅给用户
  check(
    '拒绝授权 → 告诉用户再点一次',
    copyFailText({ errno: 104 }) === '需要同意隐私授权，请再点一次',
    copyFailText({ errno: 104 })
  );
  check(
    '未声明 → 不误导用户去点隐私弹窗',
    copyFailText({ errno: 112 }) === '复制失败，请稍后重试',
    copyFailText({ errno: 112 })
  );
  check(
    'errno 缺失时用 errMsg 兜底分类',
    copyFailText({ errMsg: 'setClipboardData:fail api scope is not declared in the privacy agreement' }) === '复制失败，请稍后重试' &&
      copyFailText({ errMsg: 'setClipboardData:fail privacy deny' }) === '需要同意隐私授权，请再点一次',
    'ok'
  );

  // 无 url：不该调接口、也不该弹提示（沿用原行为，别把空复制报成成功）
  reset();
  page.data.signal = Object.assign({}, page.data.signal, { url: '' });
  page.onCopySource({ currentTarget: { dataset: {} } });
  check(
    '无 url 时不调剪贴板、不弹提示',
    wxRecord.clipboard.length === 0 && wxRecord.toasts.length === 0,
    `copy=${wxRecord.clipboard.length} toast=${wxRecord.toasts.length}`
  );

  // 两个页面必须共用同一份实现 —— 否则就是「只修了一处」的老坑。
  // 用 `wx.setClipboardData(` 而不是裸词匹配：注释里提到接口名是正常的，
  // 真正要挡住的是**又一次**手写调用。
  const srcIndex = await readFile(resolve(ROOT, 'miniprogram/pages/index/index.js'), 'utf8');
  const srcHistory = await readFile(resolve(ROOT, 'miniprogram/pages/history/index.js'), 'utf8');
  const srcClip = await readFile(resolve(ROOT, 'miniprogram/utils/clipboard.js'), 'utf8');
  const CALL = /wx\.setClipboardData\(/;
  check(
    '首页/历史页都改用公共复制函数，没有各写一份',
    /copyText\(/.test(srcIndex) &&
      /copyText\(/.test(srcHistory) &&
      !CALL.test(srcIndex) &&
      !CALL.test(srcHistory) &&
      CALL.test(srcClip),
    `index: copy=${/copyText\(/.test(srcIndex)} raw=${CALL.test(srcIndex)} / history: copy=${/copyText\(/.test(srcHistory)} raw=${CALL.test(srcHistory)}`
  );
}

/* ------------- 13. 分享：标题口径 / 单页模式适配 / 页面真的接上了 ------------- */

console.log('\n【13】分享（好友 · 朋友圈 · 单页模式）');

{
  const { indexShareTitle, historyShareTitle, isSinglePage } = await import(
    resolve(ROOT, 'miniprogram/utils/share.js')
  );

  const T0 = Date.parse('2026-09-30T12:00:00.000Z'); // 北京 20:00
  const day = 86400000;

  /* ---- 13a. 首页标题两态 ---- */

  const fcTitle = indexShareTitle({
    signal: { show: true, level: 'explicit', headline: { big: '周二', sub: '9.29 · 全天' } },
    lastAt: T0 - 3 * day,
    now: T0,
  });
  check('明确预告 → 预告句式且带上星期', fcTitle === 'Tibo 预告：周二可能重置额度', fcTitle);

  // ⚠ 本节的核心反例。`view.js` 的 signalView 给**线索档也挂 headline**，
  // 所以「有没有 headline」不足以区分预告与线索 —— 只看它就会把旁证说成承诺。
  const hintTitle = indexShareTitle({
    signal: { show: true, level: 'hint', headline: { big: '周二', sub: '9.29 · 全天' } },
    lastAt: T0 - 3 * day,
    now: T0,
  });
  check('线索档不得套用预告句式（hint 从来不是承诺）', !/预告/.test(hintTitle), hintTitle);
  check('线索档退回「等了多久」', hintTitle === '距上次重置 3 天，还在等', hintTitle);

  check(
    '无预告 → 讲已等天数',
    indexShareTitle({ signal: { show: false }, lastAt: T0 - 5 * day, now: T0 }) ===
      '距上次重置 5 天，还在等',
    indexShareTitle({ signal: { show: false }, lastAt: T0 - 5 * day, now: T0 })
  );
  check(
    '不足一天 → 落到小时档（不再写「不足一天」这种零信息量的说法）',
    indexShareTitle({ signal: { show: false }, lastAt: T0 - 3600_000, now: T0 }) ===
      '距上次重置 1 小时，还在等',
    indexShareTitle({ signal: { show: false }, lastAt: T0 - 3600_000, now: T0 })
  );
  check(
    '不足一小时 → 落到分钟档',
    indexShareTitle({ signal: { show: false }, lastAt: T0 - 600_000, now: T0 }) ===
      '距上次重置 10 分，还在等',
    indexShareTitle({ signal: { show: false }, lastAt: T0 - 600_000, now: T0 })
  );
  check(
    '什么状态都没有 → 兜底标题（不是 undefined，也不写「没检测到」）',
    indexShareTitle({}) === '等 TIBO 按按钮 · 额度重置观测台' &&
      indexShareTitle() === '等 TIBO 按按钮 · 额度重置观测台',
    indexShareTitle()
  );
  check(
    'lastAt 非法值不产出生造的天数',
    [0, null, undefined, NaN].every(
      (v) =>
        indexShareTitle({ signal: { show: false }, lastAt: v, now: T0 }) ===
        '等 TIBO 按按钮 · 额度重置观测台'
    )
  );

  // 微信分享卡片标题只有一行，超长会截断
  const titles = [
    fcTitle,
    hintTitle,
    indexShareTitle({ signal: { show: false }, lastAt: T0 - 12 * day, now: T0 }),
    indexShareTitle({}),
    historyShareTitle({ count: 29, mean: '8.4' }),
  ];
  check(
    '所有标题控制在 22 字以内',
    titles.every((t) => t.length <= 22),
    titles.map((t) => `${t}(${t.length})`).join(' | ')
  );

  /* ---- 13b. 历史页标题 ---- */

  check(
    '历史页标题直接用页面那份已格式化的 mean（不重算，免得出两个数）',
    historyShareTitle({ count: 29, mean: '8.4' }) === '29 次重置 · 平均间隔 8.4 天',
    historyShareTitle({ count: 29, mean: '8.4' })
  );
  check(
    '无记录 → 兜底标题',
    historyShareTitle({ count: 0 }) === 'TIBO 额度重置历史' &&
      historyShareTitle({}) === 'TIBO 额度重置历史'
  );

  /* ---- 13c. 单页模式判定 ---- */

  wxRecord.enterScene = 1154;
  check('scene 1154 → 单页模式', isSinglePage() === true);

  wxRecord.enterScene = 1001;
  check('scene 1001（正常打开）→ 不是单页模式', isSinglePage() === false);

  // ⚠ 最有价值的一条：cold start 是正常打开（1001），本次是从朋友圈点回来（1154）。
  // 只看 getLaunchOptionsSync 的话这里会判成「不是单页模式」，于是整页适配静默失效 ——
  // 而这条路径（先自己看过、再从朋友圈点回来）恰恰是最常见的一种。
  wxRecord.launchScene = 1001;
  wxRecord.enterScene = 1154;
  check('冷启动 1001 + 本次 1154 → 仍判为单页模式（不能只看冷启动值）', isSinglePage() === true);
  wxRecord.enterScene = 1001;

  wxRecord.enterScene = undefined;
  check('宿主没给 scene → false（宁可多显示，不要少显示）', isSinglePage() === false);

  // ⚠ 缺 getEnterOptionsSync 时必须退到 getLaunchOptionsSync，而不是直接判 false ——
  // 后者在老基础库上等于整套适配静默失效，而这是查不出来的那种坏。
  const savedEnter = wx.getEnterOptionsSync;
  const savedLaunch = wx.getLaunchOptionsSync;
  delete wx.getEnterOptionsSync;
  wxRecord.launchScene = 1154;
  check('无 getEnterOptionsSync 时退到 getLaunchOptionsSync', isSinglePage() === true);
  delete wx.getLaunchOptionsSync;
  check('两个接口都没有 → false，不抛异常', isSinglePage() === false);
  wx.getEnterOptionsSync = savedEnter;
  wx.getLaunchOptionsSync = savedLaunch;
  wxRecord.launchScene = 1001;

  wx.getEnterOptionsSync = () => {
    throw new Error('boom');
  };
  check('接口抛异常 → false，不冒泡（不能把页面带崩）', isSinglePage() === false);
  wx.getEnterOptionsSync = savedEnter;
  wxRecord.enterScene = 1001;

  /* ---- 13d. 页面真的接上了（纯函数对了但没被调用 = 没做） ---- */

  page.data.signal = { show: true, level: 'explicit', headline: { big: '周三' } };
  check(
    '首页 shareTitle() 取的是 data.signal（字段接对了）',
    page.shareTitle() === 'Tibo 预告：周三可能重置额度',
    page.shareTitle()
  );
  page.data.signal = { show: false };
  page.lastAt = Date.now() - 2 * day - 1000;
  check(
    '首页 shareTitle() 能兜到 lastAt 分支',
    page.shareTitle() === '距上次重置 2 天，还在等',
    page.shareTitle()
  );

  check('首页定义了 onShareAppMessage（不然右上角没有「转发」）', typeof page.onShareAppMessage === 'function');
  check(
    '首页转发 path 指向自己且以 / 开头',
    page.onShareAppMessage().path === '/pages/index/index' && !!page.onShareAppMessage().title,
    JSON.stringify(page.onShareAppMessage())
  );
  check('首页定义了 onShareTimeline（朋友圈入口的前置条件）', typeof page.onShareTimeline === 'function');
  check(
    '朋友圈分享不给 path（官方不支持自定义页面路径）',
    !('path' in page.onShareTimeline()),
    JSON.stringify(page.onShareTimeline())
  );

  // 历史页另加载一次模块（Page() 会被重新捕获）
  let histPage = null;
  globalThis.Page = (cfg) => {
    histPage = cfg;
  };
  await import(resolve(ROOT, 'miniprogram/pages/history/index.js'));
  check('历史页定义了 onShareAppMessage', !!histPage && typeof histPage.onShareAppMessage === 'function');
  check('历史页定义了 onShareTimeline', !!histPage && typeof histPage.onShareTimeline === 'function');
  check(
    '历史页转发 path 指向自己',
    histPage.onShareAppMessage().path === '/pages/history/index',
    histPage.onShareAppMessage().path
  );
  check(
    '历史页初始 data（无记录）取标题不炸也不出 undefined',
    histPage.onShareAppMessage().title === 'TIBO 额度重置历史',
    histPage.onShareAppMessage().title
  );

  /* ---- 13e. 模板层的单页模式守卫 ---- */

  // 模板在 Node 里渲染不了，但「守卫有没有写」可以查。少了它 = 朋友圈点开的人
  // 点了复制会弹「请前往小程序使用完整服务」—— 真机上不报错，也测不出来。
  const wxmlIndex = await readFile(resolve(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8');
  const wxmlHistory = await readFile(resolve(ROOT, 'miniprogram/pages/history/index.wxml'), 'utf8');
  const indexJson = JSON.parse(await readFile(resolve(ROOT, 'miniprogram/pages/index/index.json'), 'utf8'));
  const historyJson = JSON.parse(await readFile(resolve(ROOT, 'miniprogram/pages/history/index.json'), 'utf8'));
  const indexJs = await readFile(resolve(ROOT, 'miniprogram/pages/index/index.js'), 'utf8');
  const indexWxss = (await readFile(resolve(ROOT, 'miniprogram/pages/index/index.wxss'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');

  check(
    '首页采用自定义导航且单页模式显式 squeezed',
    indexJson.navigationStyle === 'custom' && indexJson.singlePage && indexJson.singlePage.navigationBarFit === 'squeezed',
    JSON.stringify(indexJson)
  );
  check(
    '历史页保留原生导航并使用极光背景',
    !historyJson.navigationStyle && historyJson.navigationBarBackgroundColor === '#F5F4FB' && historyJson.navigationBarTextStyle === 'black',
    JSON.stringify(historyJson)
  );
  check(
    '朋友圈单页布局不叠加状态栏与胶囊留白，品牌仍占位',
    /statusBarHeight:\s*singlePage\s*\?\s*0/.test(indexJs) && /capsuleReserve:\s*singlePage\s*\?\s*0/.test(indexJs) && /brandHeight:\s*singlePage\s*\?\s*44/.test(indexJs),
    '检查 navigationLayout(singlePage) 分支'
  );
  check(
    '胶囊矩形无效时回退安全留白',
    /validMenuLeft\s*=\s*Number\.isFinite\(menuLeft\)\s*&&\s*menuLeft\s*>\s*0\s*&&\s*menuLeft\s*<\s*width/.test(indexJs) &&
      /validMenuBottom\s*=\s*Number\.isFinite\(menuBottom\)\s*&&\s*menuBottom\s*>\s*statusBarHeight/.test(indexJs) &&
      /validMenuRect\s*=\s*validMenuLeft\s*&&\s*validMenuBottom/.test(indexJs) &&
      /capsuleReserve\s*=\s*validMenuRect\s*\?[^:]+:\s*96/.test(indexJs) &&
      /capsuleHeight\s*=\s*validMenuRect\s*\?[^:]+:\s*44/.test(indexJs),
    '左右边界、底部边界同时有效时才使用胶囊尺寸'
  );
  const cssAttributeSelector = [...indexWxss.matchAll(/([^{}]+)\{[^{}]*\}/g)].find((match) => match[1].includes('['));
  check('首页 WXSS 不含开发者工具禁用的属性选择器', !cssAttributeSelector, cssAttributeSelector ? cssAttributeSelector[1].trim() : '');
  check(
    '首页日期由独立数字位渲染，未放回单个紧缩文本',
    /wx:for="\{\{pred\.dateDigits\}\}"/.test(wxmlIndex) && !/class="eta-date[^>]*>\s*\{\{pred\.md\}\}/.test(wxmlIndex),
    '逐位循环与真实日期字段'
  );
  const tagWith = (src, attr) => src.match(new RegExp(`<[a-z-]+[^>]*${attr}[^>]*>`, 'g')) || [];

  const copyTags = [...tagWith(wxmlIndex, 'onCopySource'), ...tagWith(wxmlHistory, 'onCopy')];
  const unguarded = copyTags.filter((t) => !/singlePage/.test(t));
  check(
    `每个「复制原推链接」入口都有守卫（剪贴板在单页模式下被禁，共 ${copyTags.length} 处）`,
    copyTags.length >= 3 && unguarded.length === 0,
    unguarded.join(' | ') || `clean（${copyTags.length} 处）`
  );

  const navTags = [...(wxmlIndex.match(/<navigator[^>]*>/g) || []), ...(wxmlHistory.match(/<navigator[^>]*>/g) || [])];
  check(
    '两页的 navigator 都有守卫（单页模式下 navigator 组件被禁）',
    navTags.length === 2 && navTags.every((t) => /singlePage/.test(t)),
    `${navTags.length} 个：${navTags.join(' | ')}`
  );

  /* ---- 13f. 单页模式的底部让位（微信那条固定操作栏会压住最后一屏） ---- */

  // 与 13e 同类：模板与样式在 Node 里渲染不了，但「有没有让位」可以查出来。
  // 少了它 = 从朋友圈点开的人，页脚最后一行被微信固定的「前往小程序」操作栏
  // 永久压住；而官方运营须知明确要求「应在单页模式中尽可能呈现完整的内容」。
  const rootTags = [wxmlIndex, wxmlHistory].map(
    (s) => (s.match(/<view class="wrap[^>]*>/) || [''])[0]
  );
  check(
    '两页根容器在单页模式下都挂上底部让位类',
    rootTags.length === 2 && rootTags.every((t) => /singlePage/.test(t) && /\bsp\b/.test(t)),
    rootTags.join(' | ') || '（没找到根容器）'
  );

  const wxss = await readFile(resolve(ROOT, 'miniprogram/app.wxss'), 'utf8');
  const spRule = (wxss.match(/\.wrap\.sp\s*\{[^}]*\}/) || [''])[0];
  const spPad = Number((spRule.match(/padding-bottom:\s*(\d+)rpx/) || [])[1]);
  // 门槛 200rpx = 操作栏约 100rpx + iPhone 底部安全区约 68rpx。低于它就会露出被压住的下沿。
  check(
    '单页模式下的底部留白 ≥ 200rpx（操作栏 + 安全区）',
    Boolean(spRule) && spPad >= 200,
    spRule ? `padding-bottom=${spPad}rpx` : '（app.wxss 里没有 .wrap.sp 规则）'
  );

  // 反例守卫：让位量必须**大于**常态留白。`.wrap.sp` 是**覆盖**、不是另一个元素 ——
  // 它靠两个类的特异性压过 `.wrap`（与声明顺序无关）。两条断言分工：
  // 上一条管「够不够高」，这条管「有没有真的抬起来」。
  const basePad = Number((wxss.match(/\.wrap\s*\{[^}]*padding:[^}]*?(\d+)rpx\s*;/) || [])[1]);
  check(
    `让位量大于常态留白（常态 ${basePad}rpx）`,
    Number.isFinite(basePad) && spPad > basePad,
    `sp=${spPad}rpx vs 常态=${basePad}rpx`
  );
}

/* ---------- 13g. 首屏相邻块：几何不贴线 + 顺序不能回退 ---------- */

/* 两件事，理由完全不同，放在一起是因为它们钉的是**同一批元素**：
 *
 * ① 几何：端上 `.top` 自带 1rpx 下边框（app.wxss），它下面那些内容块要是
 *    margin-top 为 0，上边框就压在顶栏那条线上，两条 1rpx 叠成一条 ——
 *    网页端 2026-10-07 线上就是这个毛病，端上是同一套结构、同一个错法。
 *    网页端已由 `scripts/check-layout.mjs` 的 A7b 用**真实几何**盯住；
 *    端上量不到几何，退一步钉住「margin-top 非 0、且与同族同值」。
 *    ⚠ 形状级断言，别把它当成 A7b 的等价物。
 *
 * ② 顺序：2026-10-08 改版把 `.pred`（下一次什么时候）提到了首屏第一块，
 *    而它以前是 `.prog`（每日重置窗口 = 规则）。顺序回退**不会报任何错** ——
 *    页面照常渲染，只是这一页从「预测中心」退回「观察站」。
 *    这正是这次改版要修的问题，所以它必须能被机械核对，不能靠 review 时记得。
 *
 *    2026-10-09 老大又要求把「每日重置窗口」放到**预测下方**，于是它从
 *    「预测依据之后」提到「信号区之后、依据之前」。判据没变（规则不抢结论的位置），
 *    变的是它的**上界**：它划的是「这个结论的边界」（期间任何一天都可能重置），
 *    属于「这个日子有多硬」；「算得准不准」才是三张依据卡回答的。
 *    ⚠ 2026-10-08 曾以「留在信号之后仍会探进首屏（实测 375×812 露出大半）」
 *    为由把它一路后置。那条实测**没被推翻，是前提没了**：当时它上面只有 `.pred`，
 *    现在上面还压着整块 `.hero`（219px）。2026-10-09 用预览 + 无头 Chrome 重测
 *    （`dist/miniprogram-preview.html`，iframe 固定视口，375px 下 1rpx = 0.5px）：
 *      · 320×568 / 360×780 → 整块在首屏之外
 *      · 375×812 → 只露出 **15px**（≈ 上边框 + padding 上沿，读不到任何字）
 *      · 390×844 / 414×896 → 露出 47 / 99px（这两个是**下限**：预览把 rpx 固定成
 *        0.5px，真机在更宽的屏上块更高、露出更多）
 *    「挤进首屏」这个说法已经不成立 —— 结论（`.pred`）与信号（`.sig-idle`）都完整
 *    在首屏内，露出的只是它自己那条上沿。**这是老大要的位置，别再拿旧实测把它后置。** */
{
  const wxssIndex = await readFile(resolve(ROOT, 'miniprogram/pages/index/index.wxss'), 'utf8');
  /* 同一个选择器在文件里可能有好几条规则（`.sig` 既有一条 `animation-delay`、
   * 又有一条真正设尺寸的），所以不能只取第一条匹配 —— 那会读到 `animation-delay`
   * 那条、拿不到边距。这里遍历该选择器的**全部**规则，取第一条真带边距的。
   * 边距可能写成 `margin-top`，也可能被收进 `margin` 简写的第一位，两种都认。 */
  const topMarginOf = (selEscaped) => {
    const rules = wxssIndex.match(new RegExp('^' + selEscaped + '\\s*\\{[^}]*\\}', 'gm')) ?? [];
    for (const r of rules) {
      const long = r.match(/margin-top:\s*(-?[\d.]+)rpx/);
      if (long) return Number(long[1]);
      // 简写只取第一位的数值即可，**不要**要求数值后面紧跟 `rpx` ——
      // `margin: 0 0 20rpx` 这类写法会让正则匹配不上、报出 `NaNrpx` 这种难读的失败信息。
      const short = r.match(/margin:\s*(-?[\d.]+)/);
      if (short) return Number(short[1]);
    }
    return NaN;
  };
  const hasRule = (selEscaped) => new RegExp('^' + selEscaped + '\\s*\\{', 'm').test(wxssIndex);

  /* 同族 = 会**相邻出现**的那几块。`.top` 下面依次是 hero → pred → sig|sig-idle
   * → prog，彼此相邻处各有一条 1rpx 边框，所以这几块的上边距必须是同一个数。
   * `.pred` 单独看一遍的理由：它是 2026-10-08 新加入这个家族的，最容易被写漏。
   *
   * ⚠ `.prog`（每日重置窗口）**进出这一族走过两趟**，改之前先确认它的
   *   **上方邻居是谁**，别只看类名：
   *     · 2026-10-08 移出 —— 那时它排在「预测依据之后」，上方邻居是 `.bc-grid`
   *       里的 `.bc`（也带边框），但不再是这几块，所以不能要求同值；
   *     · 2026-10-09 收回 —— 它挪回「信号之后」，上方邻居**又变回带边框的
   *       `.sig` / `.sig-idle`**，「与同族同值」重新成为必要条件。
   *   两次都是对的，错的是照抄上一次的 `FAMILY`。
   */
  const FAMILY = ['.pred', '.sig', '.sig-idle', '.prog'];
  const margins = FAMILY.map((s) => [s, topMarginOf(s.replace('.', '\\.'))]);
  const missing = margins.filter(([, v]) => !Number.isFinite(v)).map(([s]) => s);
  check(
    '首屏相邻的四块都有上边距',
    missing.length === 0,
    missing.length ? `缺 margin-top：${missing.join(' / ')}` : margins.map(([s, v]) => `${s}=${v}`).join(' · ')
  );
  const first = margins[0][1];
  check(
    '四块的上边距彼此一致（相邻处两条 1rpx 边框才不会被压在一起）',
    Number.isFinite(first) && first >= 8 && margins.every(([, v]) => v === first),
    margins.map(([s, v]) => `${s}=${v}`).join(' · ')
  );
  // 与上一条重复，但把它单独留一条：`.prog` 是最常被搬来搬去的那块，
  // 单独报出它的值比在四块的一长串里找它快。上面那条绿而这条红 = 只错在 `.prog`。
  check(
    '每日重置窗口的上边距 ≥8（上方邻居是同样带边框的 .sig / .sig-idle，不能贴线）',
    topMarginOf('\\.prog') >= 8,
    `.prog=${topMarginOf('\\.prog')}`
  );

  /* ---- 顺序 ---- */
  // ⚠ 再读一次 wxml：13e 里那个 `wxmlIndex` 声明在**块作用域**里，出了那块就没了，
  //   直接引用会 ReferenceError（实测踩过一次）。别为了省一次读文件去改作用域。
  const wxmlIndex = await readFile(resolve(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8');
  // 先剥注释再找位置：注释里会提到类名（这一页的注释特别多），
  // 拿原串比下标会把注释里的 `class="pred"` 也算进去。
  const wxmlBody = wxmlIndex.replace(/<!--[\s\S]*?-->/g, '');
  const at = (needle) => wxmlBody.indexOf(needle);
  // 2026-10-08 第三轮：「已经等了多久」（`.hero`）从页尾提到**最前**，锚点随之新增。
  // 它必须留在下面那条前置断言里 —— 用旧锚点会 `-1`，而 `-1` 恰好能让「排在之前」
  // 那类比较**看起来**成立（`-1 < x` 恒真），所以「找得到」那条必须留着。
  const iHero = at('class="hero"');
  const iPred = at('class="pred ');
  const iSig = at('class="sig ');
  const iProg = at('class="prog"');
  // 2026-10-08 第二轮：依据区从 `.fc`（一块 `card fc-meta`）扩成 `.bc-grid`（三张卡），
  // 并在它后面**新增**了一组 `.hr-grid`（历史规律：三张图从「各占一节」收成一组）。
  // 锚点随之从 `.fc` 换成这两个 —— 用旧锚点会 `-1`，同样会被上面那条前置断言挡住。
  const iBc = at('class="bc-grid"');
  const iHr = at('class="hr-grid"');

  check(
    '模板里找得到六块（顺序断言的前提）',
    [iHero, iPred, iSig, iProg, iBc, iHr].every((i) => i >= 0),
    `hero=${iHero} pred=${iPred} sig=${iSig} prog=${iProg} bc=${iBc} hr=${iHr}`
  );
  check(
    '预测总览排在信号之前（结论在前，依据在后）',
    iPred >= 0 && iSig >= 0 && iPred < iSig,
    `pred@${iPred} vs sig@${iSig}`
  );
  check(
    '预测依据（.bc-grid 三卡）排在预测总览之后',
    iPred >= 0 && iBc >= 0 && iBc > iPred,
    `bc@${iBc} vs pred@${iPred}`
  );
  // 2026-10-09：「每日重置窗口」从「依据之后」提到「信号之后、依据之前」。
  // **两条一起钉** —— 只钉「在依据之前」的话，它越过 `.pred` 挤回首屏也会绿，
  // 而那正是 2026-10-08 要修的毛病（第一条断言就是为它加的）。
  check(
    '每日重置窗口排在信号区之后（规则不抢结论的位置）',
    iSig >= 0 && iProg >= 0 && iProg > iSig,
    `prog@${iProg} vs sig@${iSig}`
  );
  check(
    '每日重置窗口排在预测依据之前（它划的是结论的边界，不是「算得准不准」）',
    iProg >= 0 && iBc >= 0 && iProg < iBc,
    `prog@${iProg} vs bc@${iBc}`
  );
  check(
    '历史规律（.hr-grid 三张图）排在每日重置窗口之后',
    iProg >= 0 && iHr >= 0 && iHr > iProg,
    `hr@${iHr} vs prog@${iProg}`
  );
  // 2026-10-08 第三轮：大计数器从**页尾**提到**最前**（事实在前、推断在后），
  // 判据的方向跟着反过来。两条一起钉：只钉一条的话，「挪一半」（删了旧位置、
  // 忘了插新位置，或插到了别处）可能不报。
  check(
    '「已经等了多久」的大计数器排在预测总览之前（事实在前、推断在后）',
    iHero >= 0 && iPred >= 0 && iHero < iPred,
    `hero@${iHero} vs pred@${iPred}`
  );
  check(
    '大计数器也排在预测依据与三张图之前（它不再后置到页尾）',
    iHero >= 0 && iBc > 0 && iHr > 0 && iHero < iBc && iHero < iHr,
    `hero@${iHero} vs bc@${iBc} / hr@${iHr}`
  );
  check(
    '间隔直方图的 canvas 在模板里（第三层图表的第一张）',
    at('id="hist"') > iHr,
    `hist@${at('id="hist"')} vs hr@${iHr}`
  );
}

/* ------------------------------ 结果 ------------------------------ */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
