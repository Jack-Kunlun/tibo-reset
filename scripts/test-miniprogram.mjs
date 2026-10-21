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
        boundingClientRect: () => q,
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
    stopPullDownRefresh: () => { record.pullDownStopCount = (record.pullDownStopCount || 0) + 1; },
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
      for (const id of ids) {
        res[id] = record.subscribeVerdicts && Object.prototype.hasOwnProperty.call(record.subscribeVerdicts, id)
          ? record.subscribeVerdicts[id]
          : record.subscribeVerdict;
      }
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

{
  const { drawScene } = await import('../miniprogram/utils/draw.js');
  const scene = { width: 120, height: 80, elements: [
    { k: 'text', s: '天', x: 10, y: 20, fill: '#73708a' },
    { k: 'line', x1: 10, y1: 30, x2: 100, y2: 30, stroke: '#e4e1ee' },
    { k: 'poly', pts: [[10, 40], [50, 40], [50, 70]], grad: { color: '#6150d4', a0: 0.2, a1: 0, y0: 40, y1: 70 } },
  ] };
  const original = JSON.stringify(scene);
  const ctx = makeFakeCanvas().getContext();
  const calls = [];
  ctx.fillText = (s, x, y) => calls.push(['text', s, x, y, ctx.fillStyle]);
  ctx.stroke = () => calls.push(['stroke', ctx.strokeStyle]);
  ctx.createLinearGradient = () => ({ addColorStop: (at, color) => calls.push(['gradient', at, color]) });
  drawScene(ctx, scene, 1, 'night');
  check('夜色图表保持坐标并同时转换文字、网格和渐变',
    calls.some((c) => c[0] === 'text' && c[2] === 10 && c[3] === 20 && c[4] === '#9CA6C2') &&
    calls.some((c) => c[0] === 'stroke' && c[1] === '#272F45') &&
    calls.some((c) => c[0] === 'gradient' && c[2] === 'rgba(180,163,255,0.2)') &&
    JSON.stringify(scene) === original);
  calls.length = 0;
  drawScene(ctx, scene);
  check('未指定夜色的历史页保留原画笔',
    calls.some((c) => c[0] === 'text' && c[4] === '#73708a') &&
    calls.some((c) => c[0] === 'stroke' && c[1] === '#e4e1ee') &&
    calls.some((c) => c[0] === 'gradient' && c[2] === 'rgba(97,80,212,0.2)'));
}

let captured = null;
globalThis.Page = (cfg) => {
  captured = cfg;
};
let capturedApp = null;
globalThis.App = (cfg) => { capturedApp = cfg; };
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
  pullDownStopCount: 0,
  subscribeVerdict: 'accept',
  subscribeVerdicts: null,
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

await import(resolve(ROOT, 'miniprogram/app.js'));
{
  const pageHost = globalThis.wx;
  const events = {};
  const modals = [];
  let warmups = 0;
  let applies = 0;
  let managers = 0;
  globalThis.wx = {
    ...pageHost,
    getUpdateManager() {
      managers++;
      return {
        onUpdateReady: (cb) => { events.ready = cb; },
        onUpdateFailed: (cb) => { events.failed = cb; },
        applyUpdate: () => { applies++; },
      };
    },
    showModal: (opts) => modals.push(opts),
  };
  const app = { ...capturedApp, warmup() { warmups++; } };
  app.onLaunch();
  check('App 启动注册更新监听，同时保留数据预热', warmups === 1 && typeof events.ready === 'function' && typeof events.failed === 'function');
  wxRecord.enterScene = 1154;
  app.onShow();
  events.ready();
  check('App 朋友圈单页入口不弹重启提示', modals.length === 0);
  app.onHide();
  wxRecord.enterScene = 1001;
  app.onShow();
  check('App 普通入口会提示已下载的更新', modals.length === 1);
  modals[0].success({ cancel: true });
  modals[0].complete();
  app.onHide();
  app.onShow();
  check('App 再次回前台会提醒，更新管理器只注册一次', modals.length === 2 && managers === 1);
  modals[1].success({ confirm: true });
  modals[1].complete();
  check('App 确认后调用微信 applyUpdate', applies === 1);
  globalThis.wx = pageHost;
}

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
  const { createDashboardPage } = await import('../miniprogram/utils/dashboard.js');
  const drawPage = { ...page, ...createDashboardPage('analysis'), data: { ...page.data, pageVisible: true }, ready: true, chart: page.chart, _painting: false, _paintAgain: false };
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

{
  const originalQuery = wx.createSelectorQuery;
  const measurements = [];
  wx.createSelectorQuery = () => {
    const query = { in: () => query, select: () => query, boundingClientRect: () => query, exec: (callback) => measurements.push(callback) };
    return query;
  };
  try {
    page.onToggleProgram();
    page.onToggleProgram();
    measurements[0]([{ height: 320 }]);
    check('快速关闭后，迟到的测量不会重新撑开每日窗口', !page.data.programOpen && page.data.programHeight === 0);
    page.onToggleProgram();
    page.onToggleProgram();
    page.onToggleProgram();
    measurements[1]([{ height: 400 }]);
    measurements[2]([{ height: 280.5 }]);
    check('连续切换只采用最后一次展开的真实高度', page.data.programOpen && page.data.programHeight === 281, String(page.data.programHeight));
    page.onToggleProgram();
    check('收起回到零高度，内容节点可保留播放过渡', !page.data.programOpen && page.data.programHeight === 0);

    /* 上面三条都只在「同一页内开关」这一面。守卫还有**后半条** ——
       `measure !== this._programMeasure` —— 它只在**页面卸载之后回调才到达**时才
       起作用：那时 `programOpen` 仍为 `true`（`onUnload` 不会清 data），前半个条件
       挡不住，只有 measure 变了才能拦住这次迟到写入。
       ⚠ 少了这条用例，后半条守卫就是**恒绿**的：早先实测「只摘掉 measure 一半」
       时上面三条全绿，摘掉整条才变红 —— 说明它此前完全没有覆盖。 */
    page.onToggleProgram();
    const lateMeasure = measurements.length - 1;
    page.onUnload();
    measurements[lateMeasure]([{ height: 512 }]);
    check(
      '页面卸载后迟到的测量不再写回（这条只认 measure 守卫，不认 programOpen）',
      page.data.programHeight === 0,
      String(page.data.programHeight)
    );
  } finally {
    wx.createSelectorQuery = originalQuery;
  }
}

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
    note.length > 8 && (d.pred.etaKind === 'announced'
      ? /依据来自公告本身/.test(note) && !/三项.*容差内/.test(note)
      : d.pred.etaBasis === 'announcement-delay' ? /预告到落地的可配对样本/.test(note) && !/都在容差内/.test(note)
      : failed === 0 ? /都在容差内/.test(note) : new RegExp(`有 ${failed} 项未达标`).test(note)),
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
  '③ 依据摘要区分公告时间、未定时预告与没有公告',
  ov.announcement?.pending ? /已预告重置，具体时间待公布/.test(ov.brief) :
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
  if (ov.etaBasis === 'announcement-delay') {
    const arrival = (await import(resolve(ROOT, 'miniprogram/data/snapshot.js'))).default.prediction.announcementDelay;
    const {fmtSpan} = await import(resolve(ROOT, 'miniprogram/utils/format.js'));
    check('依据摘要来源行显示预告到落地配对数',rows[0].label==='预告到落地' && rows[0].value===`${arrival.sampleCount} 次配对`);
    check('条件估计依据为预告后中位耗时，不搬间隔模型覆盖率', rows[1].label==='中位耗时' && rows[1].value===fmtSpan(arrival.medianMs/86400_000));
    check('条件估计依据范围使用历史最小和最大耗时',rows[2].label==='历史耗时范围' && rows[2].value===`${fmtSpan(arrival.minMs/86400_000)} – ${fmtSpan(arrival.maxMs/86400_000)}`);
  } else {
  check('依据摘要的来源行与当前预测模式一致', rows[0].value === sourceValue, `${rows[0].value} / ${sourceValue}`);
  check('覆盖率行复用回测的 80% 区间值', rows[1].value === coverage.v, `${rows[1].value} / ${coverage.v}`);
  check('近期节奏行复用最新分段均值', rows[2].value === `${phase.mean}${phase.unit.replace(/\s+/g, '')}`, rows[2].value);
  }
  const calendar=d.calendar;
  check('日历接入首页且格子保留实际日期与状态',calendar?.zone==='UTC' && calendar.cells.length===calendar.days && calendar.cells.every(c=>/^\d{2}\/\d{2}$/.test(c.label) && c.statusLabel));
  check('日历确认数与预告条数分别保留，格内合计不混淆',calendar.confirmedCount===calendar.cells.reduce((n,c)=>n+c.confirmedCount,0) && calendar.awaitingCount===calendar.cells.reduce((n,c)=>n+c.pendingCount+c.datedCount,0));
  const plan=d.planView;
  check('首页显示28格业务Day计划，最新进度取原帖编号而非日历日期',plan?.show && plan.days.length===28 && plan.days.every((row,index)=>row.day===index+1) && plan.latestLabel===`最新原帖 Day ${plan.latestDay} / ${plan.dayCount}` && d.selectedPlanDay===plan.latestDay);
  check('计划明细保留人工摘要、来源与北京时间，不展开长原文',d.selectedPlan?.entries.every(entry=>entry.title && entry.when && typeof entry.text==='string' && typeof entry.url==='string') && d.expandedPlanEntry==='');
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
  'tick() 后有效模型或公告时间挂倒计时，缺样本时没有倒计时',
  ov.hasEstimate ? !!page.data.pred.cd && Array.isArray(page.data.pred.cd.groups) && page.data.pred.cd.groups.length === 2 : page.data.pred.cd === null,
  JSON.stringify(page.data.pred.cd)
);
check(
  '有效倒计时只显示相邻的最高两组单位',
  !ov.hasEstimate ? page.data.pred.cd === null :
    ['天时', '时分', '分秒'].includes((page.data.pred.cd.groups || []).map((g) => g.unit).join('')),
  JSON.stringify(page.data.pred.cd?.groups)
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
  const pending = predCountdown({ etaAt: anchor + 3600_000, etaKind: 'model', announcement: { pending: true } }, anchor);
  check('未定时预告的模型耗时估计与公告倒计时分开措辞', !pending.over && pending.groups.length === 2 && pending.label === '距模型预计到账');
  check('缺耗时样本而没有ETA时不展示倒计时', predCountdown({etaAt:null,announcement:{pending:true}},anchor) === null);
}
// 过点之后的措辞必须分档：公告档不能说「已到中位预测时刻」—— 那时根本没有中位预测。
// 直接喂一个「已经过点」的 ETA，而不是等它真的过期（那要等到数据换代）。
let overModelLabel = '';
let overAnnLabel = '';
{
  const realEta = page.data.pred.etaAt;
  const realKind = page.data.pred.etaKind;
  const realAnnouncement = page.data.pred.announcement;
  const nowMs = Date.now();
  page.data.pred.etaAt = nowMs - 60_000;
  // 这组测已给出时间的过点行为，与当前快照是否恰好处于未定时预告无关。
  page.data.pred.announcement = null;

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
  page.data.pred.announcement = realAnnouncement;
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
  '未来的 ETA 才显示「预计还需等待」',
  (await import(resolve(ROOT, 'miniprogram/utils/view.js'))).predCountdown({ etaAt: 1_000_001, etaKind: 'model' }, 1_000_000).label === '预计还需等待'
);

console.log('\n【5】信号');

// 断言必须从数据推出，不能写死 —— 否则收录到一条真的预告后这条用例就假失败
const snapshotSignals = (await import(resolve(ROOT, 'miniprogram/data/snapshot.js'))).default.signals;

// 明确预告可以待公布时间；线索仍须带窗口。
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
  check('醒目态给出时间窗口或标明待公布', !!d.signal.window || d.signal.timing === 'pending', JSON.stringify(d.signal.window));
  if (d.signal.window) {
    check('窗口含双时区', !!(d.signal.window.sourceZone && d.signal.window.userZone), JSON.stringify(d.signal.window));
    check('窗口含时差说明', !!d.signal.window.diffText, d.signal.window.diffText);
  }
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
    // 「画出了内容」只判**种类**，不判个数 —— 个数是数据的函数：
    // 节奏图的网格线条数由「末七次间隔的最大值」经 step 推出（max 4.26 → step 5 → 只画 1 条），
    // 窗口一移、最大值跨过台阶，网格线 2 条→1 条，图元 22→20，而图本身没有任何问题。
    // 这里原先写的是 `scene.elements.length > 20`：2026-10-11 采集后它红了，且红的时机
    // 由数据决定、不由缺陷决定 —— 那种断言除了制造噪音，还会训练人「看到红就调阈值」。
    // 全库对拍见 decisions.md D-056。
    const kinds = new Set(scene.elements.map((e) => e.k));
    check(
      `${w}px · ${s.name} 画出内容（有几何图元 + 有文字）`,
      kinds.has('text') && [...kinds].some((k) => k !== 'text'),
      `${scene.elements.length} 个图元 / ${[...kinds].sort().join('+')}`
    );
  }
}

/* ---------------- 7b. 图元构成：判据挂在输入上，不钉魔数 ----------------
 *
 * 上面那条是**种类**判据（与数据无关）；这一组是**构成**判据：某个种类的个数
 * = 由输入直接算出来的值。两条合起来才算「没有静默退化」—— 只判种类会漏掉
 * 「圆点全没了但还剩一根线」，只判总数则会像旧断言那样被数据牵着走。
 */
const keysOf = (els, k) => els.filter((e) => e.k === k).length;

const rhythmEls = rhythmScene(chart, { layout: 'compact', width: 341, height: 160 }).elements;
const n7 = Math.min(7, chart.gapDays.length);
check('节奏图：面积 + 折线恰好 2 条 poly', keysOf(rhythmEls, 'poly') === 2, `${keysOf(rhythmEls, 'poly')} 条`);
check(
  '节奏图：圆点 = 末 N 段各一颗 + 末点光晕',
  keysOf(rhythmEls, 'circle') === n7 + 1,
  `${keysOf(rhythmEls, 'circle')} 个 / 期望 ${n7 + 1}（N=${n7}）`
);

const stripEls = stripScene(chart, { layout: 'compact', width: 341, height: 230 }).elements;
check(
  '点阵分布：圆点 = 每段间隔一颗 + 当前标记（超 14 天的改画在右侧，同样一颗）',
  keysOf(stripEls, 'circle') === chart.gapDays.length + 1,
  `${keysOf(stripEls, 'circle')} 个 / 期望 ${chart.gapDays.length + 1}`
);

const survEls = survivalScene(chart, { layout: 'compact', width: 341, height: 208 }).elements;
const cappedN = chart.gapDays.filter((d) => d > 14).length;
check('生存曲线：只有一个圆点（「现在」那个标记）', keysOf(survEls, 'circle') === 1, `${keysOf(survEls, 'circle')} 个`);
check(
  '生存曲线：面积 + 折线；有超 14 天的段时另加一条封顶提示线',
  keysOf(survEls, 'poly') === 2 + (cappedN ? 1 : 0),
  `${keysOf(survEls, 'poly')} 条 / 封顶 ${cappedN} 段`
);

// 那条旧断言的**真实失效模式**本身要守在案：网格线条数**应该**随最大值变，
// 于是这里断言的是「怎么变」（每多一条线 = 多 1 条 line + 1 个刻度文字 = 2 个图元），
// 而不是总数。夹具固定，差值就是确定的 4。
const rhythmWithMax = (maxGap) => {
  const gapDays = [maxGap, maxGap * 0.5, maxGap * 0.25, maxGap * 0.75, maxGap * 0.4, maxGap * 0.6, maxGap * 0.9];
  const recs = gapDays.map((_, i) => ({ at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }));
  return rhythmScene({ gapDays, records: recs }, { layout: 'compact', width: 341, height: 160 }).elements;
};
const gridSmall = rhythmWithMax(2); // step=1 → 3 条网格线
const gridLarge = rhythmWithMax(4.5); // step=5 → 1 条网格线
check(
  '节奏图：网格线条数随最大值增减（每多一条 = 多 2 个图元），总数不该被钉死',
  gridSmall.length - gridLarge.length === 4,
  `${gridSmall.length} vs ${gridLarge.length}`
);

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
const { buildSignal, buildOutlookView } = await import(resolve(ROOT, 'miniprogram/utils/view.js'));

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

// 反例：只讨论额度，没有承诺重置，不得进醒目态。
const noTimeSig = detectSignals([mkTweet('We are reviewing usage limits across all plans.', '9002')], { now });
check('该推文确实没有解析出时间窗口', !noTimeSig.hints.some((h) => h.window), JSON.stringify(noTimeSig.hints.map((h) => h.window)));
check(
  '只讨论额度、未承诺重置时，不进醒目态',
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
check('北京时间卡片的开始、结束均取真实窗口端点', progVm.program.beijingRange.every((point, i) => `${point.date} ${point.time}` === fmt.fmtDateTime(i ? progSig.program.window.toTs : progSig.program.window.fromTs)), JSON.stringify(progVm.program.beijingRange));
check('当地日期范围保留原文粒度，不补入钟点', progVm.program.localRange.map((point) => `${point.date}（${point.weekday}）`).join(' – ') === progSig.program.window.sourceZone && progVm.program.localRange.every((point) => !/\d{1,2}:\d{2}/.test(point.date)), JSON.stringify(progVm.program.localRange));
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

const pendingSig = detectSignals([mkTweet('A reset is coming for everyone.', '9005')], { now });
const pendingVm = buildSignal(pendingSig);
check('明确预告没有时间也展示', pendingVm.show && pendingVm.level === 'explicit' && pendingVm.timing === 'pending');
check('未定时间预告显示待公布且保留依据', pendingVm.title.includes('时间待公布') && pendingVm.timeNote === '具体时间待公布' && pendingVm.evCount === 1 && pendingVm.ev[0].text.includes('reset is coming'));
check('未定时间预告不造窗口或倒计时锚点', pendingVm.window === null && pendingVm.headline === null);
const pendingOutlookVm = buildOutlookView(chart, snapPred, pendingSig, now);
check('小程序预测卡保留未定时间预告事实，估计按预告后耗时', pendingOutlookVm.etaKind === 'model' && pendingOutlookVm.etaBasis === 'announcement-delay' && pendingOutlookVm.brief.includes('已预告重置，具体时间待公布') && !pendingOutlookVm.brief.includes('没有公告') && !pendingOutlookVm.brief.includes('均不足以构成预告'));
{
  const { predCountdown } = await import(resolve(ROOT, 'miniprogram/utils/view.js'));
  const cd = predCountdown(pendingOutlookVm, now);
  check('小程序未定时间预告进入公告态，条件估计有独立范围与样本量', pendingOutlookVm.announcement?.pending === true && pendingOutlookVm.announcement.text.includes('reset is coming') && (pendingOutlookVm.hasEstimate ? cd.groups.length === 2 && pendingOutlookVm.bandLabel === '历史到账范围' && pendingOutlookVm.arrivalRows[0].value.includes('次配对') : cd === null));
  const announced = buildOutlookView(chart, snapPred, { forecasts: [{
    precision: 'day', counts: { hard: 1 },
    window: { fromTs: now - 60_000, toTs: now + 3_600_000 },
    text: 'Global reset landing by EOD PST time. Enjoy',
    url: 'https://x.com/thsottiaux/status/2109812360596865224',
    createdAt: new Date(now - 60_000).toISOString(),
  }] }, now);
  check('小程序公告主卡直接保留原文、来源与北京时间', announced.announcement?.text.includes('Global reset landing') && announced.announcement.url.endsWith('/2109812360596865224') && /\d{2}\.\d{2} \d{2}:\d{2} 北京/.test(announced.announcement.when));
}

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
const toggleReminder = (kind) => page.onToggleReminder({ currentTarget: { dataset: { kind } } });

check('未取得可用模板时不能申请授权', sub.subscribeAvailable() === false);
check(
  '每类入口都说明一次授权只对应一次通知',
  /一次/.test(sub.SCOPE_HINT) && /通知/.test(sub.SCOPE_HINT),
  sub.SCOPE_HINT
);

// 四种授权结果必须分开说 —— 用户能做的处理完全不同，笼统报「失败」等于没提示
check('accept → 成功', sub.classifySubscribeResult({ [TMPL]: 'accept' }, TMPL).ok === true);
check('reject → 提示是他自己点了拒绝', /拒绝/.test(sub.classifySubscribeResult({ [TMPL]: 'reject' }, TMPL).reason));
check('ban → 如实提示模板不可用', /不可用/.test(sub.classifySubscribeResult({ [TMPL]: 'ban' }, TMPL).reason));
check('未知结果 → 不谎报成功', sub.classifySubscribeResult({}, TMPL).ok === false);

// 真实线上旧服务返回 404 时，通知模块仍可见，重试只查询配置，不索取授权。
configMod.enabled = true;
const grantsBeforeConfig = wxRecord.subscribeCalls.length, loginsBeforeConfig = wxRecord.loginCount;
page.initRemind();
wxRecord.onRequest = (opts) => opts.success({ statusCode: 404, data: { error: 'unknown endpoint' } });
await page.refreshReminders();
await toggleReminder('announcement');
check('通知配置 404 时两项都保留重试入口，不授权、不登录、不显示已开启', page.data.announcementRemind.show && page.data.announcementRemind.state === 'unknown' && page.data.announcementRemind.label === '重试' && page.data.landedRemind.show && page.data.landedRemind.state === 'unknown' && wxRecord.subscribeCalls.length === grantsBeforeConfig && wxRecord.loginCount === loginsBeforeConfig);
wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: { enabled: false, templateId: '' } });
await page.refreshReminders();
await toggleReminder('landed');
check('通知服务未启用时两项显示未开放并阻止授权', page.data.announcementRemind.show && page.data.announcementRemind.state === 'unavailable' && page.data.landedRemind.state === 'unavailable' && wxRecord.subscribeCalls.length === grantsBeforeConfig && wxRecord.loginCount === loginsBeforeConfig);

// 旧服务缺少 kinds 时仍支持落地通知，预告项明确等待服务升级。
configMod.enabled = true;
configMod.subscribeTemplateId = '';
wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: opts.url.endsWith('/config')
  ? { enabled: true, templateId: TMPL, scope: 'once' }
  : { ok: true, active: false } });
await sub.loadSubscriptionConfig();
check('旧服务兼容落地通知，但不伪称支持预告通知', sub.subscribeAvailable('landed') === true && sub.subscribeAvailable('announcement') === false);
await page.refreshReminders();
check('旧服务仍显示落地入口，预告显示待服务升级', page.data.landedRemind.state === 'idle' && page.data.announcementRemind.state === 'unavailable' && /升级/.test(page.data.announcementRemind.label));

// 新服务声明两个独立通知类型。
wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: opts.url.endsWith('/config')
  ? { enabled: true, templateId: TMPL, kinds: ['announcement', 'landed'], scope: 'once' }
  : { ok: true, active: false } });
await page.refreshReminders();
check('新服务配置后两类通知都可独立开启', sub.subscribeAvailable('announcement') && sub.subscribeAvailable('landed') && page.data.announcementRemind.state === 'idle' && page.data.landedRemind.state === 'idle');

const pullKinds = [];
const previousLoad = page.load;
let forcedLoads = 0;
page.load = async (options) => { if (options?.force) forcedLoads++; };
const stopsBeforePull = wxRecord.pullDownStopCount;
wxRecord.onRequest = (opts) => {
  if (opts.url.endsWith('/config')) return opts.success({ statusCode: 200, data: { enabled: true, templateId: TMPL, kinds: ['announcement', 'landed'] } });
  pullKinds.push(opts.data.kind);
  opts.success({ statusCode: 200, data: { ok: true, active: opts.data.kind === 'announcement' } });
};
await page.onPullDownRefresh();
page.load = previousLoad;
check('下拉刷新同时查询并更新预告与落地授权状态',
  pullKinds.sort().join() === 'announcement,landed' && page.data.announcementRemind.state === 'on' &&
  page.data.landedRemind.state === 'idle' && forcedLoads === 1 && wxRecord.pullDownStopCount === stopsBeforePull + 1);

page.initRemind();
check(
  '两项通知入口分别显示对应操作',
  page.data.announcementRemind.show === true && page.data.announcementRemind.label === sub.ACTION_LABELS.announcement && page.data.landedRemind.label === sub.ACTION_LABELS.landed,
  JSON.stringify([page.data.announcementRemind.label, page.data.landedRemind.label])
);

const posts = [];
wxRecord.onRequest = (opts) => {
  posts.push({ url: opts.url, method: opts.method, data: opts.data });
  opts.success({ statusCode: 200, data: { ok: true, active: true } });
};

await toggleReminder('announcement');
check('预告授权提交独立 kind，且不提交客户端 openid', posts.at(-1)?.data?.kind === 'announcement' && posts.at(-1)?.data?.templateId === TMPL && !!posts.at(-1)?.data?.code && !('openid' in posts.at(-1).data));
const firstAnnouncementGrant = posts.at(-1)?.data?.grantId;
check('每次微信真实授权都附带稳定的 grantId', typeof firstAnnouncementGrant === 'string' && firstAnnouncementGrant.length > 8);
check('开启预告通知不会改变落地项状态', page.data.announcementRemind.state === 'on' && page.data.landedRemind.state === 'idle');
check('申请授权时仍使用公开模板 ID', wxRecord.subscribeCalls.slice(-1)[0] === TMPL, wxRecord.subscribeCalls.join(' | '));
check('走了一次 wx.login 换 code', wxRecord.loginCount > 0, String(wxRecord.loginCount));
check(
  '预告授权上报到 /api/subscribe（POST）',
  /\/api\/subscribe$/.test(posts.at(-1)?.url || '') && posts.at(-1)?.method === 'POST',
  posts.at(-1) && `${posts.at(-1).method} ${posts.at(-1).url}`
);
check('成功后预告按钮显示已开启，落地仍可单独授权', page.data.announcementRemind.label === sub.DONE_LABELS.announcement && page.data.announcementRemind.tone === 'ok' && page.data.landedRemind.label === sub.ACTION_LABELS.landed);

await toggleReminder('landed');
check('落地授权也独立提交 landed kind', posts.at(-1)?.data?.kind === 'landed' && page.data.landedRemind.state === 'on' && page.data.announcementRemind.state === 'on');

// 拒绝分支：不该产生任何网络动作
wxRecord.subscribeVerdict = 'reject';
page.initRemind();
const loginBefore = wxRecord.loginCount;
const reqBefore = wxRecord.requestCount;
await toggleReminder('announcement');
check('用户拒绝时不换 code、不上报', wxRecord.loginCount === loginBefore && wxRecord.requestCount === reqBefore);
check('用户拒绝时给出可操作提示', page.data.announcementRemind.tone === 'warn' && /拒绝/.test(page.data.announcementRemind.feedback), page.data.announcementRemind.feedback);
check('用户拒绝后预告项仍可重新授权', page.data.announcementRemind.state === 'idle' && page.data.landedRemind.state === 'idle');

// 授权成功但后端同步失败：微信侧已经计入一次授权，不能谎报成功骗用户再点一次
wxRecord.subscribeVerdict = 'accept';
const retryPosts = [];
wxRecord.onRequest = (opts) => {
  if (opts.url.endsWith('/subscribe')) retryPosts.push(opts.data);
  opts.success({ statusCode: 503, data: { error: 'subscribe disabled' } });
};
page.initRemind();
await toggleReminder('announcement');
check(
  '授权成功但同步失败 → 如实说「可能收不到」，不谎报成功',
  page.data.announcementRemind.state === 'retry' && page.data.announcementRemind.tone === 'warn' && /同步/.test(page.data.announcementRemind.feedback),
  page.data.announcementRemind.feedback
);
check('预告待同步标记与落地授权状态分开保存', sub.hasPendingSync('announcement') && !sub.hasPendingSync('landed'));

// 兼容旧服务的「任一授权 active」状态：它不能证明这次新的 grant 已登记。
let pendingGrantChecked = '';
wxRecord.onRequest = (opts) => {
  if (opts.url.endsWith('/config')) return opts.success({ statusCode: 200, data: { enabled: true, templateId: TMPL, kinds: ['announcement', 'landed'] } });
  if (opts.url.endsWith('/status')) {
    if (opts.data.kind === 'announcement') pendingGrantChecked = opts.data.grantId;
    return opts.success({ statusCode: 200, data: { ok: true, active: opts.data.kind === 'announcement' } });
  }
  return opts.success({ statusCode: 503, data: { error: 'subscribe disabled' } });
};
await page.refreshReminders();
check('旧授权仍 active 时，新 grant 未获精确确认仍保留可点的重试状态',
  !!pendingGrantChecked && page.data.announcementRemind.state === 'retry' && page.data.announcementRemind.label === '重试同步' && sub.hasPendingSync('announcement'));

// 已有微信授权时，重试登记不能再次弹授权或叠加授权次数。
const granted = wxRecord.subscribeCalls.length;
wxRecord.onRequest = (opts) => {
  if (opts.url.endsWith('/subscribe')) retryPosts.push(opts.data);
  opts.success({ statusCode: 200, data: { ok: true, active: true } });
};
await toggleReminder('announcement');
check('同步失败后只重试预告登记，服务器确认后才显示已开启', wxRecord.subscribeCalls.length === granted && page.data.announcementRemind.state === 'on' && !sub.hasPendingSync('announcement') && !sub.hasPendingSync('landed'));
check('同步失败后的重试复用同一 grantId，不制造第二份授权',
  retryPosts.length === 2 && !!retryPosts[0].grantId && retryPosts[0].grantId === retryPosts[1].grantId);

wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: opts.url.endsWith('/config') ? { enabled: true, templateId: TMPL, kinds: ['announcement', 'landed'] } : { ok: true, active: false } });
await page.refreshReminders();
check('服务查询确认授权已消耗后恢复两项按钮，不信任本地永久标记', page.data.announcementRemind.state === 'idle' && page.data.announcementRemind.label === sub.ACTION_LABELS.announcement && page.data.landedRemind.label === sub.ACTION_LABELS.landed);

// 两个新模板必须从同一首页按钮发起一次批量授权；选择默认开启，但初始化与状态查询不授权。
const ANN_TMPL = 'ANNOUNCEMENT_TEST';
const batchConfig = {
  enabled: true,
  templateId: TMPL,
  templateIds: { announcement: ANN_TMPL, landed: TMPL },
  kinds: ['announcement', 'landed'],
  scope: 'once',
};
const respondWithBatchConfig = (opts) => opts.success({ statusCode: 200, data: opts.url.endsWith('/config') ? batchConfig : { ok: true, active: false } });
wxRecord.onRequest = respondWithBatchConfig;
await sub.loadSubscriptionConfig();
page.initRemind();
const batchPopupStart = wxRecord.subscribeCalls.length;
await page.refreshReminders();
check('新模板配置默认勾选两类提醒，初始化与状态刷新不弹授权',
  sub.supportsBatchSubscription() && page.data.reminderBatch && page.data.announcementRemind.selected && page.data.landedRemind.selected &&
  wxRecord.subscribeCalls.length === batchPopupStart);
check('两类均选中时使用一个明确的批量开启按钮',
  page.data.reminderAction.label === '开启重置提醒' && page.data.reminderAction.disabled === false);

const sceneBatchCalls = wxRecord.subscribeCalls.length;
page.data.singlePage = true;
page.initRemind();
page.onSelectReminder({ currentTarget: { dataset: { kind: 'announcement' } } });
await page.onEnableReminders();
check('scene 1154 单页隐藏并拦截两个新授权入口',
  !page.data.announcementRemind.show && !page.data.landedRemind.show &&
  page.data.announcementRemind.selected && page.data.landedRemind.selected &&
  wxRecord.subscribeCalls.length === sceneBatchCalls);
page.data.singlePage = false;
page.initRemind();
await page.refreshReminders();

// 快速连点不能在上一份原生授权仍打开时再申请第二次。
const nativeRequestSubscribeForGuard = wx.requestSubscribeMessage;
let settleGuardPopup;
wx.requestSubscribeMessage = (opts) => {
  wxRecord.subscribeCalls.push((opts.tmplIds || []).join(','));
  settleGuardPopup = opts.success;
};
const guardPopupStart = wxRecord.subscribeCalls.length;
const guardedBatch = page.onEnableReminders();
const repeatedBatch = page.onEnableReminders();
const onePopupOnly = wxRecord.subscribeCalls.length === guardPopupStart + 1 && repeatedBatch === undefined;
check('联合授权在点击中直接调用微信接口，不先等待登录或网络', typeof settleGuardPopup === 'function');
settleGuardPopup({ [ANN_TMPL]: 'reject', [TMPL]: 'reject' });
await guardedBatch;
wx.requestSubscribeMessage = nativeRequestSubscribeForGuard;
check('批量提醒正在处理时重复点击不会叠加第二次微信授权', onePopupOnly && wxRecord.subscribeCalls.length === guardPopupStart + 1);

// 两类都同意时，两个待办必须在任何 wx.login / HTTP 登记之前全部落盘；服务器失败也要逐项保留。
wxRecord.subscribeVerdicts = { [ANN_TMPL]: 'accept', [TMPL]: 'accept' };
const acceptedPosts = [];
const pendingAtLogin = [];
const nativeLogin = wx.login;
wx.login = (opts) => {
  pendingAtLogin.push({ announcement: sub.hasPendingSync('announcement'), landed: sub.hasPendingSync('landed') });
  return nativeLogin(opts);
};
wxRecord.onRequest = (opts) => {
  if (opts.url.endsWith('/config')) return opts.success({ statusCode: 200, data: batchConfig });
  if (opts.url.endsWith('/subscribe')) acceptedPosts.push(opts.data);
  return opts.success({ statusCode: 503, data: { error: 'temporary failure' } });
};
const batchCallsBeforeGrant = wxRecord.subscribeCalls.length;
await page.onEnableReminders();
wx.login = nativeLogin;
check('单击一次只调用一次微信弹窗，并传入两个不同模板 ID',
  wxRecord.subscribeCalls.length === batchCallsBeforeGrant + 1 && wxRecord.subscribeCalls.at(-1) === `${ANN_TMPL},${TMPL}`,
  wxRecord.subscribeCalls.at(-1));
check('两项授权结果先分别持久化，再开始任一 wx.login',
  pendingAtLogin.length === 2 && pendingAtLogin.every((entry) => entry.announcement && entry.landed), JSON.stringify(pendingAtLogin));
check('两类分别携带正确 kind、模板与独立 grantId 登记',
  acceptedPosts.length === 2 && acceptedPosts.some((entry) => entry.kind === 'announcement' && entry.templateId === ANN_TMPL) &&
  acceptedPosts.some((entry) => entry.kind === 'landed' && entry.templateId === TMPL) &&
  acceptedPosts[0].grantId !== acceptedPosts[1].grantId && acceptedPosts.every((entry) => !!entry.code && !('openid' in entry)));
check('登记失败后两类各自保留可重试状态与待办',
  page.data.announcementRemind.state === 'retry' && page.data.landedRemind.state === 'retry' &&
  sub.hasPendingSync('announcement') && sub.hasPendingSync('landed'));

// 只选一项重试待同步授权时，不再弹窗；另一项仍保留自己的待办。
page.onSelectReminder({ currentTarget: { dataset: { kind: 'landed' } } });
wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: opts.url.endsWith('/config') ? batchConfig : { ok: true, active: true } });
const retryPopupStart = wxRecord.subscribeCalls.length;
await page.onEnableReminders();
check('已有授权的单项重试只同步，不再次弹窗或清除另一项待办',
  wxRecord.subscribeCalls.length === retryPopupStart && page.data.announcementRemind.state === 'on' &&
  page.data.landedRemind.state === 'retry' && sub.hasPendingSync('landed'));

// 若另一类已有待同步授权、当前选择中还有新类型，先同步申请新类型；即使弹窗失败，待办仍可独立同步。
wxRecord.onRequest = (opts) => {
  if (opts.url.endsWith('/config')) return opts.success({ statusCode: 200, data: batchConfig });
  if (opts.url.endsWith('/status')) return opts.success({ statusCode: 200, data: { ok: true, active: false } });
  return opts.success({ statusCode: 200, data: { ok: true, active: true } });
};
await page.refreshReminders();
page.onSelectReminder({ currentTarget: { dataset: { kind: 'landed' } } });
const nativeRequestSubscribeForFailure = wx.requestSubscribeMessage;
const authorizeOrder = [];
wx.requestSubscribeMessage = (opts) => {
  wxRecord.subscribeCalls.push((opts.tmplIds || []).join(','));
  authorizeOrder.push('popup');
  opts.fail({ errMsg: 'popup failed' });
};
const nativeLoginForOrder = wx.login;
wx.login = (opts) => { authorizeOrder.push('login'); return nativeLoginForOrder(opts); };
const failedNewPopupStart = wxRecord.subscribeCalls.length;
await page.onEnableReminders();
wx.login = nativeLoginForOrder;
wx.requestSubscribeMessage = nativeRequestSubscribeForFailure;
check('有待同步授权和新授权时先申请新模板；弹窗失败仍独立完成待同步登记',
  authorizeOrder[0] === 'popup' && authorizeOrder.includes('login') &&
  wxRecord.subscribeCalls.length === failedNewPopupStart + 1 && wxRecord.subscribeCalls.at(-1) === ANN_TMPL &&
  page.data.announcementRemind.state === 'idle' && page.data.landedRemind.state === 'on' &&
  !sub.hasPendingSync('landed'));

// 一个拒绝、另一个同意时，两边状态不能互相覆盖，也不能登记被拒绝的一类。
wxRecord.subscribeVerdicts = { [ANN_TMPL]: 'reject', [TMPL]: 'accept' };
const mixedPosts = [];
wxRecord.onRequest = (opts) => {
  if (opts.url.endsWith('/config')) return opts.success({ statusCode: 200, data: batchConfig });
  if (opts.url.endsWith('/status')) return opts.success({ statusCode: 200, data: { ok: true, active: false } });
  if (opts.url.endsWith('/subscribe')) mixedPosts.push(opts.data);
  return opts.success({ statusCode: 200, data: { ok: true, active: true } });
};
await page.refreshReminders();
const mixedPopupStart = wxRecord.subscribeCalls.length;
await page.onEnableReminders();
check('微信对两模板分别返回拒绝和同意时，只登记同意的类型',
  wxRecord.subscribeCalls.length === mixedPopupStart + 1 && mixedPosts.length === 1 &&
  mixedPosts[0].kind === 'landed' && mixedPosts[0].templateId === TMPL &&
  page.data.announcementRemind.state === 'idle' && /拒绝/.test(page.data.announcementRemind.feedback) &&
  page.data.landedRemind.state === 'on');
wxRecord.subscribeVerdicts = null;

// 状态查询失败后总入口要能重试查询，但点击不能退化成授权。
wxRecord.onRequest = (opts) => {
  if (opts.url.endsWith('/config')) return opts.success({ statusCode: 200, data: batchConfig });
  if (opts.url.endsWith('/status')) return opts.fail({ errMsg: 'temporary offline' });
  return opts.success({ statusCode: 200, data: { ok: true, active: false } });
};
await page.refreshReminders();
check('未知状态显示可操作的重试检查，而非永久 loading',
  page.data.announcementRemind.state === 'unknown' && page.data.reminderAction.label === '重试检查' &&
  page.data.reminderAction.disabled === false && page.data.reminderAction.loading === false);
const unknownPopupStart = wxRecord.subscribeCalls.length;
wxRecord.onRequest = (opts) => {
  if (opts.url.endsWith('/config')) return opts.success({ statusCode: 200, data: batchConfig });
  return opts.success({ statusCode: 200, data: { ok: true, active: false } });
};
await page.onEnableReminders();
check('重试检查只刷新配置和状态，不请求微信授权',
  wxRecord.subscribeCalls.length === unknownPopupStart && page.data.announcementRemind.state === 'idle');

page.onSelectReminder({ currentTarget: { dataset: { kind: 'announcement' } } });
page.onSelectReminder({ currentTarget: { dataset: { kind: 'landed' } } });
check('两类都取消选择时不会显示成功，也不能提交',
  page.data.reminderAction.label === '请选择提醒类型' && page.data.reminderAction.disabled === true);

// 字段一旦出现就严格按类型读取；损坏映射、缺 key 或重复 ID 均不能回退伪装成批量模板。
for (const invalidMap of [null, [], 'broken', {}]) {
  wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: {
    enabled: true, templateId: TMPL, templateIds: invalidMap, kinds: ['announcement', 'landed'],
  } });
  await sub.loadSubscriptionConfig();
  check(`存在但无效的 templateIds 不回退 scalar（${JSON.stringify(invalidMap)}）`,
    !sub.subscribeAvailable('announcement') && !sub.subscribeAvailable('landed') &&
    !sub.supportsNotificationKind('announcement') && !sub.supportsNotificationKind('landed') &&
    !sub.supportsBatchSubscription());
}
wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: {
  enabled: true, templateId: TMPL, templateIds: { announcement: ANN_TMPL }, kinds: ['announcement', 'landed'],
} });
await sub.loadSubscriptionConfig();
check('缺失的单类映射不借用旧 scalar，剩余单类也不能伪装批量',
  sub.subscribeAvailable('announcement') && !sub.subscribeAvailable('landed') &&
  sub.supportsNotificationKind('announcement') && !sub.supportsNotificationKind('landed') &&
  !sub.supportsBatchSubscription());
wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: {
  enabled: true, templateId: TMPL, templateIds: { announcement: TMPL, landed: TMPL }, kinds: ['announcement', 'landed'],
} });
await sub.loadSubscriptionConfig();
check('重复模板 ID 不代表两份独立授权',
  !sub.supportsBatchSubscription() && !sub.supportsNotificationKind('announcement') && sub.supportsNotificationKind('landed'));

// 配置在微信弹窗期间切换时，原 ID 的授权不能被同步到新模板。
wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: batchConfig });
await sub.loadSubscriptionConfig();
const nativeRequestSubscribeForBatch = wx.requestSubscribeMessage;
let acceptCapturedBatch;
wx.requestSubscribeMessage = (opts) => {
  wxRecord.subscribeCalls.push((opts.tmplIds || []).join(','));
  acceptCapturedBatch = () => opts.success(Object.fromEntries(opts.tmplIds.map((id) => [id, 'accept'])));
};
const batchRacePosts = [];
const batchRace = sub.subscribeKinds(['announcement', 'landed']);
await Promise.resolve();
wxRecord.onRequest = (opts) => opts.url.endsWith('/config')
  ? opts.success({ statusCode: 200, data: { enabled: true, templateId: 'NEW_LANDED', templateIds: { announcement: 'NEW_ANNOUNCEMENT', landed: 'NEW_LANDED' }, kinds: ['announcement', 'landed'] } })
  : (batchRacePosts.push(opts.data), opts.success({ statusCode: 200, data: { ok: true, active: true } }));
await sub.loadSubscriptionConfig();
acceptCapturedBatch();
const batchRaceResult = await batchRace;
wx.requestSubscribeMessage = nativeRequestSubscribeForBatch;
check('弹窗期间配置切换时两类旧授权都不登记到新模板',
  !batchRacePosts.length && batchRaceResult.announcement.status === 'template-changed' &&
  batchRaceResult.landed.status === 'template-changed' && !sub.hasPendingSync('announcement') && !sub.hasPendingSync('landed'));

// 返回旧 scalar 服务，保留原有逐项入口并继续走后续朋友圈单页回归。
wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: opts.url.endsWith('/config')
  ? { enabled: true, templateId: TMPL, kinds: ['announcement', 'landed'], scope: 'once' }
  : { ok: true, active: false } });
await sub.loadSubscriptionConfig();
page.initRemind();
await page.refreshReminders();

const callsBefore = wxRecord.subscribeCalls.length;
const singleLoginBefore = wxRecord.loginCount, singleRequestBefore = wxRecord.requestCount;
page.data.singlePage = true;
await page.refreshReminders();
page.initRemind();
await toggleReminder('announcement');
check('朋友圈单页不展示任一入口、不触发授权', !page.data.announcementRemind.show && !page.data.landedRemind.show && wxRecord.subscribeCalls.length === callsBefore && wxRecord.loginCount === singleLoginBefore && wxRecord.requestCount === singleRequestBefore);
page.data.singlePage = false;
page.initRemind();

// 错误响应不能被包装成开通成功。
wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: { ok: true } });
const unconfirmed = await sub.syncSubscription();
check('HTTP 成功但没有 active 确认，不显示开通成功', unconfirmed.synced === false);

// 授权弹窗期间另一类请求可能刷新服务配置，旧模板的 accept 不能被登记到新模板。
let acceptCapturedTemplate;
const nativeRequestSubscribe = wx.requestSubscribeMessage;
wx.requestSubscribeMessage = (opts) => {
  wxRecord.subscribeCalls.push((opts.tmplIds || []).join(','));
  acceptCapturedTemplate = () => opts.success({ [opts.tmplIds[0]]: 'accept' });
};
const racePosts = [];
const raceSubscription = sub.subscribeOnce('announcement');
await Promise.resolve();
wxRecord.onRequest = (opts) => opts.url.endsWith('/config')
  ? opts.success({ statusCode: 200, data: { enabled: true, templateId: 'NEW_TEMPLATE', kinds: ['announcement', 'landed'] } })
  : (racePosts.push(opts.data), opts.success({ statusCode: 200, data: { ok: true, active: true } }));
await sub.loadSubscriptionConfig();
acceptCapturedTemplate();
const templateRace = await raceSubscription;
wx.requestSubscribeMessage = nativeRequestSubscribe;
check('授权过程中模板切换时不把旧模板 accept 同步到新模板',
  templateRace.status === 'template-changed' && !racePosts.length && !sub.hasPendingSync('announcement'));

wxRecord.onRequest = (opts) => opts.url.endsWith('/config')
  ? opts.success({ statusCode: 200, data: { enabled: true, templateId: 'NEW_TEMPLATE', kinds: ['announcement', 'landed'] } })
  : (racePosts.push(opts.data), opts.success({ statusCode: 422, data: { code: 'template_changed', error: 'template changed' } }));
const templateChanged = await sub.subscribeOnce('announcement');
check('模板更换清除对应类型的同步待办并要求重新授权', templateChanged.ok === false && templateChanged.status === 'template-changed' && !sub.hasPendingSync('announcement') && /重新/.test(templateChanged.reason));
wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: { enabled: true, templateId: TMPL, kinds: ['announcement', 'landed'] } });
await sub.loadSubscriptionConfig();

// code 是一次性的：每次调用都必须重新 wx.login
const codes = [];
const repeatedGrantIds = [];
wxRecord.onRequest = (opts) => {
  codes.push(opts.data && opts.data.code);
  repeatedGrantIds.push(opts.data && opts.data.grantId);
  opts.success({ statusCode: 200, data: { ok: true, active: true } });
};
await sub.subscribeOnce('landed');
await sub.subscribeOnce('landed');
check('每次都重新 wx.login 且新授权生成新的 grantId', codes.length === 2 && codes[0] !== codes[1] && !!repeatedGrantIds[0] && repeatedGrantIds[0] !== repeatedGrantIds[1], codes.join(' / '));

// 缺模板 ID 时应在本地就拦住，不去骚扰微信接口
configMod.subscribeTemplateId = '';
wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: { enabled: false, templateId: '' } });
await sub.loadSubscriptionConfig();
let blocked = false;
try {
  await sub.subscribeOnce();
} catch (err) {
  blocked = /模板/.test(err.message);
}
check('缺模板 ID 时本地报错，不调用微信接口', blocked);
configMod.subscribeTemplateId = TMPL;
wxRecord.onRequest = (opts) => opts.success({ statusCode: 200, data: { enabled: true, templateId: TMPL } });
await sub.loadSubscriptionConfig();

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
  reset();
  page.onCopyCalendarSource({ currentTarget: { dataset: {} } });
  check('无来源日历格不复制当前预告链接', wxRecord.clipboard.length === 0 && wxRecord.toasts.length === 0);
  page.onCopyCalendarSource({ currentTarget: { dataset: {url:URL_OK} } });
  check('有来源日历格只复制本格链接',wxRecord.clipboard[0]===URL_OK);
  reset();
  const wasSinglePage=page.data.singlePage;page.data.singlePage=true;
  page.onCopyCalendarSource({currentTarget:{dataset:{url:URL_OK}}});
  check('朋友圈单页模式的日历不调用剪贴板',wxRecord.clipboard.length===0);
  page.data.singlePage=wasSinglePage;

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
  const srcIndex = await readFile(resolve(ROOT, 'miniprogram/utils/dashboard.js'), 'utf8');
  const srcHistory = await readFile(resolve(ROOT, 'miniprogram/utils/dashboard.js'), 'utf8');
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
  const wxmlIndex = (await readFile(resolve(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8')).replace(/class="tr-(?:view|text|button|image) /g, 'class="');
  const wxmlHistory = (await readFile(resolve(ROOT, 'miniprogram/pages/history/index.wxml'), 'utf8')).replace(/class="tr-(?:view|text|button|image) /g, 'class="');
  const indexJson = JSON.parse(await readFile(resolve(ROOT, 'miniprogram/pages/index/index.json'), 'utf8'));
  const historyJson = JSON.parse(await readFile(resolve(ROOT, 'miniprogram/pages/history/index.json'), 'utf8'));
  const indexJs = await readFile(resolve(ROOT, 'miniprogram/utils/dashboard.js'), 'utf8');
  const indexWxss = ((await readFile(resolve(ROOT, 'miniprogram/styles/dashboard.wxss'), 'utf8')) + (await readFile(resolve(ROOT, 'miniprogram/styles/design.wxss'), 'utf8'))).replace(/\/\*[\s\S]*?\*\//g, '');

  check(
    '首页采用自定义导航且单页模式显式 squeezed',
    indexJson.navigationStyle === 'custom' && indexJson.singlePage && indexJson.singlePage.navigationBarFit === 'squeezed',
    JSON.stringify(indexJson)
  );
  check(
    '记录页与观测页统一自定义导航和极光背景',
    historyJson.navigationStyle === 'custom' && historyJson.backgroundColor === '#090D19' && historyJson.navigationBarTextStyle === 'white',
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
  const universalSelector = [...indexWxss.matchAll(/([^{}]+)\{[^{}]*\}/g)].find(match => match[1].includes('*'));
  check('设计样式不含微信编译器禁用的通配选择器', !universalSelector);
  check(
    '首页按设计稿展示预测日期与独立钟点',
    wxmlIndex.includes('class="tr-eta-date"') && wxmlIndex.includes('pred.md') && wxmlIndex.includes('class="tr-eta-time"'),
    '真实日期与钟点分层显示'
  );
  const tagWith = (src, attr) => src.match(new RegExp(`<[a-z-]+[^>]*${attr}[^>]*>`, 'g')) || [];

  const copyTags = [...tagWith(wxmlIndex, 'onCopySource'), ...tagWith(wxmlHistory, 'onCopySource'), ...tagWith(wxmlHistory, 'onCopyCalendarSource')];
  const unguarded = copyTags.filter((t) => !/singlePage/.test(t));
  check(
    `每个「复制原推链接」入口都有守卫（剪贴板在单页模式下被禁，共 ${copyTags.length} 处）`,
    copyTags.length >= 3 && unguarded.length === 0,
    unguarded.join(' | ') || `clean（${copyTags.length} 处）`
  );

  const navTags = [...(wxmlIndex.match(/<navigator[^>]*>/g) || []), ...(wxmlHistory.match(/<navigator[^>]*>/g) || [])];
  check(
    '原生Tab页面没有遗留 navigate 跳转，单页模式不显示额外导航',
    navTags.length === 0,
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

/* ------------------ 三 Tab 的职责与原生路由 ------------------ */
{
  const app = JSON.parse(await readFile(resolve(ROOT, 'miniprogram/app.json'), 'utf8'));
  const home = await readFile(resolve(ROOT, 'miniprogram/pages/index/index.wxml'), 'utf8');
  const records = await readFile(resolve(ROOT, 'miniprogram/pages/history/index.wxml'), 'utf8');
  const analysis = await readFile(resolve(ROOT, 'miniprogram/pages/analysis/index.wxml'), 'utf8');
  const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/class="tr-(?:view|text|button|image) /g, 'class="');
  const h = strip(home), r = strip(records), a = strip(analysis);
  check('微信原生Tab固定为观测、记录、分析，保留旧历史分享路由',
    app.tabBar.list.map(t => t.text).join(',') === '观测,记录,分析' &&
    app.tabBar.list.map(t => t.pagePath).join(',') === 'pages/index/index,pages/history/index,pages/analysis/index');
  check('三Tab图标均为存在的本地PNG', app.tabBar.list.every(t =>
    existsSync(resolve(ROOT, 'miniprogram', t.iconPath)) && existsSync(resolve(ROOT, 'miniprogram', t.selectedIconPath))));
  check('首页信号置顶，预测之后是提醒、紧凑经过时间与28天计划',
    h.indexOf('class="tr-signal ') >= 0 && h.indexOf('class="tr-signal ') < h.indexOf('class="tr-outlook"') &&
    h.indexOf('class="tr-outlook"') < h.indexOf('class="tr-reminders"') &&
    h.indexOf('class="tr-reminders"') < h.indexOf('class="tr-elapsed"') &&
    h.indexOf('class="tr-elapsed"') < h.indexOf('class="tr-window tr-plan"') && h.includes('planView.latestLabel') && h.includes('bindtap="onSelectPlanDay"'));
  check('计划默认按官方Day编号展示，原规则与来源收在折叠说明内',
    h.includes('28 天规则') && h.includes('planView.summary') && h.includes('selectedPlan.entries') && h.includes('bindtap="onToggleProgram"') && h.includes('bindtap="onCopySource"'));
  const planDisplayContract = (markup) => {
    const freshness = markup.indexOf('planView.freshnessText');
    return freshness >= 0 && freshness < markup.indexOf('class="tr-view tr-plan-grid"') &&
      freshness < markup.indexOf('class="tr-view tr-plan-explain"') &&
      (markup.match(/class="tr-view tr-plan-legend-item"/g) || []).length === 3 &&
      markup.includes('更新+重置') && markup.includes('tr-plan-legend-note') &&
      markup.includes('<view wx:if="{{item.hasText}}" class="tr-view tr-plan-action"') &&
      markup.includes('<view wx:if="{{item.url && !singlePage}}" class="tr-view tr-plan-action"');
  };
  check('计划保留三类主图例、其他状态说明、常驻快照时刻和可用操作', planDisplayContract(home));
  check('计划快照时刻移出首屏摘要会被断言拦截', !planDisplayContract(home.replace('        <text class="tr-text tr-plan-freshness">{{planView.freshnessText}}</text>\n', '')));
  check('移除更新+重置主图例会被断言拦截', !planDisplayContract(home.replace('更新+重置', '更新')));
  check('移除计划其他状态说明会被断言拦截', !planDisplayContract(home.replace('tr-plan-legend-note', 'tr-plan-legend-detail')));
  check('计划操作不再承载于不可控基线的文本节点', !planDisplayContract(home.replace('<view wx:if="{{item.hasText}}" class="tr-view tr-plan-action"', '<text wx:if="{{item.hasText}}" class="tr-text tr-plan-action"')));
  check('首页不再堆叠日历、历史记录和完整图表', !/reset-calendar|id="trend"|id="hist"|id="survival"|id="strip"/.test(h));
  check('两类提醒仍在首页且未增加提醒Tab', /data-kind="announcement"/.test(h) && /data-kind="landed"/.test(h) && !/onToggleReminder/.test(r+a));
  check('新模板按选择状态共用一个批量入口，旧服务仍有逐项回退入口',
    home.includes('{{reminderBatch}}') && home.includes('bindtap="onSelectReminder"') &&
    home.includes('bindtap="onEnableReminders"') && home.includes('{{reminderAction.label}}') &&
    home.includes('loading="{{reminderAction.loading}}"') && home.includes('bindtap="onToggleReminder"') &&
    home.includes('loading="{{announcementRemind.state === \'busy\' || announcementRemind.state === \'checking\'}}"') &&
    home.includes('aria-checked="{{announcementRemind.selected}}"'));
  check('记录页日历可点选明细，之后展示完整记录',
    r.includes('bindtap="onSelectCalendarDay"') && r.includes('selectedDay.details') && r.includes('allRecords') &&
    r.indexOf('tr-calendar-card') < r.indexOf('tr-selected-date') && r.indexOf('tr-selected-date') < r.indexOf('tr-history-list'));
  check('分析页保留节奏、回测、概率、历史三图和样本披露',
    ['class="tr-bars"','data-bc="wait"','data-bc="backtest"','data-bc="pace"','id="hist"','id="survival"','id="strip"','class="metrics"'].every(t=>a.includes(t)));
  check('三个Tab均声明数据截至时间，未用请求时刻冒充采集时刻',
    [home,records,analysis].every(t=>t.includes('数据截至 {{dataText}}')));
}

console.log('\n【14】状态刷新不是重复返回旧内存缓存');
{
  const api = await import('../miniprogram/utils/api.js');
  const config = (await import('../miniprogram/config.js')).default;
  const savedWx = globalThis.wx, savedNow = Date.now, savedEnabled = config.enabled;
  let now = savedNow(), requests = 0;
  Date.now = () => now;
  config.enabled = true;
  globalThis.wx = { request(o) { requests++; o.fail({ errMsg: 'offline' }); }, getStorageSync() { return null; } };
  try {
    api.clearMemo();
    const first = await api.loadState();
    const cached = await api.loadState();
    check('缓存降级结果仍明确标为快照，不能变成正常观测', first.degraded && cached.degraded && cached.reason === first.reason);
    check('刷新间隔内可以复用缓存', requests === 1);
    now += config.refreshIntervalMs + 1;
    await api.loadState();
    check('缓存过期后必须真正再请求 API', requests === 2);
    const state = api.snapshotState();
    globalThis.wx.request = (o) => { requests++; o.success({ statusCode: 200, data: { ...state, chart: { ...state.chart, lastAt: '2026-10-15T06:28:13.000Z' } } }); };
    globalThis.wx.setStorageSync = () => {};
    const fresh = await api.loadState({ force: true });
    check('强制刷新能更新上次重置而不是继续返回快照', !fresh.degraded && fresh.state.chart.lastAt === '2026-10-15T06:28:13.000Z');
    const {buildCalendarView} = await import('../miniprogram/utils/view.js');
    const legacySignals = {...state.signals};delete legacySignals.calendar;
    const legacyRemote = {...state,signals:legacySignals,generatedAt:new Date(now+60_000).toISOString(),dataUpdatedAt:new Date(now+60_000).toISOString()};
    let calendarCache;
    globalThis.wx.setStorageSync = (_,value)=>{calendarCache=value;};
    globalThis.wx.getStorageSync = ()=>calendarCache;
    globalThis.wx.request = o=>o.success({statusCode:200,data:legacyRemote});
    const legacy = await api.loadState({force:true});
    check('旧后端缺日历时只对日历降级，保留当前接口数据',!legacy.degraded && legacy.state.source==='api' && legacy.state.generatedAt===legacyRemote.generatedAt && legacy.state.signals.calendar?.source==='snapshot');
    const legacyCalendar = buildCalendarView(legacy.state.signals.calendar);
    check('局部日历快照明确标注原始数据时间，不冒充接口刚更新时间',legacyCalendar.snapshot && legacyCalendar.freshnessText.includes('日历快照') && legacy.state.signals.calendar.dataAsOf===state.signals.calendar.dataAsOf);
    const {buildProgramPlanView} = await import('../miniprogram/utils/view.js');
    const {plan:ignoredPlan,...legacyCalendarWithoutPlan}=state.signals.calendar;
    const oldPlanRemote={...legacyRemote,signals:{...legacySignals,calendar:{...legacyCalendarWithoutPlan,title:'旧服务日历'}}};
    globalThis.wx.request = o=>o.success({statusCode:200,data:oldPlanRemote});
    const oldPlanFallback=await api.loadState({force:true});
    const planFallbackView=buildProgramPlanView(oldPlanFallback.state.signals.calendar.plan);
    check('旧服务有日历但缺计划时只回补同账号计划快照并标原始数据时刻',
      oldPlanFallback.state.signals.calendar.title==='旧服务日历' && oldPlanFallback.state.signals.calendar.plan?.source==='snapshot' &&
      oldPlanFallback.state.signals.calendar.plan.dataAsOf===state.dataUpdatedAt && planFallbackView.freshnessText.includes('计划快照'));
    globalThis.wx.request = o=>o.success({statusCode:200,data:{...oldPlanRemote,signals:{...legacySignals,calendar:{...legacyCalendarWithoutPlan,plan:null}}}});
    check('服务端显式 plan:null 时不回补旧计划',
      (await api.loadState({force:true})).state.signals.calendar.plan===null);
    const legacyHost={...captured,data:{...page.data},setData(patch){Object.assign(this.data,patch);},tick(){},paint(){}};
    legacyHost.apply({state:legacy.state,degraded:false});
    check('接口覆盖首屏后，日历仍能进入首页可见数据',legacyHost.data.calendar?.cells.length===state.signals.calendar.cells.length && legacyHost.data.calendar.freshnessText.includes('日历快照'));
    globalThis.wx.request = o=>o.fail({errMsg:'offline'});
    const cachedCalendar = await api.loadState({force:true});
    check('缓存保留日历快照来源，重试失败不推进它的数据时刻',cachedCalendar.degraded && cachedCalendar.state.signals.calendar.source==='snapshot' && cachedCalendar.state.signals.calendar.dataAsOf===legacy.state.signals.calendar.dataAsOf);
    const {source:ignoredSource,dataAsOf:ignoredAsOf,...serverCalendar}=state.signals.calendar;
    const newRemote={...legacyRemote,signals:{...legacySignals,calendar:{...serverCalendar,title:'服务端日历'}}};
    globalThis.wx.request = o=>o.success({statusCode:200,data:newRemote});
    const upgraded = await api.loadState({force:true});
    check('新后端提供日历后自动替换快照并使用服务端数据时刻',upgraded.state.signals.calendar.title==='服务端日历' && upgraded.state.signals.calendar.source==='api' && upgraded.state.signals.calendar.dataAsOf===newRemote.dataUpdatedAt && !buildCalendarView(upgraded.state.signals.calendar).snapshot);
    globalThis.wx.request = o=>o.success({statusCode:200,data:{...newRemote,signals:{...legacySignals,calendar:null}}});
    check('新后端明确不提供日历时，不复活旧活动快照',(await api.loadState({force:true})).state.signals.calendar===null);
    globalThis.wx.request = o=>o.success({statusCode:200,data:{...legacyRemote,account:'different-account'}});
    check('不同账号的接口数据不混入包内日历',!(await api.loadState({force:true})).state.signals.calendar);
    let calls = [];
    const host = { ...captured, data: { pageVisible: true, motionEnabled: false }, _lastLoad: now - config.refreshIntervalMs - 1,
      setData() {}, startTicker() {}, refreshRemind() {}, load(o) { calls.push(o); }, lastAt: null };
    captured.onShow.call(host);
    check('切回前台超过间隔会强制联网刷新', calls.length === 1 && calls[0].force === true);
    calls = [];
    captured.tick.call(host);
    check('一直停留首页也会定期拉取最新状态', calls.length === 1 && calls[0].force === true && calls[0].silent === true);
    calls = [];
    host.data.pageVisible = false;
    captured.tick.call(host);
    check('隐藏页面不继续拉取状态', calls.length === 0);
    const measurements = [];
    globalThis.wx.createSelectorQuery = () => {
      const query = { in: () => query, select: () => query, boundingClientRect: () => query, exec: (callback) => measurements.push(callback) };
      return query;
    };
    const refreshed = { ...captured, data: { ...page.data, programOpen: true, programHeight: 120 }, _programMeasure: 0,
      setData(patch, callback) { Object.assign(this.data, patch); callback?.(); }, tick() {}, paint() {} };
    refreshed.apply({ state, degraded: false, preserveUi: true });
    refreshed.apply({ state, degraded: false, preserveUi: true });
    measurements[1]?.([{ height: 410.5 }]);
    measurements[0]?.([{ height: 300 }]);
    check('静默刷新保留展开并重测高度，迟到结果不裁切新内容', refreshed.data.programOpen && measurements.length === 2 && refreshed.data.programHeight === 411);
  } finally {
    Date.now = savedNow; config.enabled = savedEnabled; globalThis.wx = savedWx; api.clearMemo();
  }
}

/* ------------------------------ 结果 ------------------------------ */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
