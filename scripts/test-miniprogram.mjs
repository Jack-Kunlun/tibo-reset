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
    getWindowInfo: () => ({ pixelRatio: 3 }),
    getSystemInfoSync: () => ({ pixelRatio: 3 }),
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
// 计时器换成手动驱动，否则 Node 进程会被 setInterval 吊住
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

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
};
globalThis.wx = makeWx(wxRecord);

await import(PAGE_PATH);
if (!captured) {
  console.error('✗ 页面模块没有调用 Page()，无法继续');
  process.exit(1);
}

// 造一个最小页面实例：setData 直接合并到 data，并记下载荷
const page = Object.assign(Object.create(null), captured, {
  data: JSON.parse(JSON.stringify(captured.data)),
});
page.setData = (patch, cb) => {
  renders.push(patch);
  Object.assign(page.data, patch);
  if (typeof cb === 'function') cb();
};

console.log('【1】页面生命周期');
await page.onLoad();
await Promise.resolve();
page.onReady();
await new Promise((r) => setTimeout(r, 30));

check('onLoad / onReady 未抛异常', true);

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
check('since 文案已生成', typeof d.since === 'string' && d.since.includes('上次重置'), d.since);
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
check('概率条 5 条', d.forecast.bars.length === 5, `实际 ${d.forecast.bars.length}`);
check(
  '概率条宽度都在 1%–100%',
  d.forecast.bars.every((b) => Number(b.w) >= 1 && Number(b.w) <= 100),
  JSON.stringify(d.forecast.bars.map((b) => b.w))
);
check('中位剩余为数值', /^[0-9.]+$/.test(d.forecast.q50), d.forecast.q50);
check('80% 区间格式正确', /^[0-9.]+ – [0-9.]+$/.test(d.forecast.rangeText), d.forecast.rangeText);
check('回测表 3 行', d.forecast.cal.rows.length === 3, `实际 ${d.forecast.cal.rows.length}`);
check('阶段表非空', d.forecast.phases.length >= 2, `实际 ${d.forecast.phases.length}`);
check(
  '阶段表日期已格式化（不是 ISO 原文）',
  d.forecast.phases.every((p) => /^\d{4}\.\d{2}\.\d{2}$/.test(p.from) && /^\d{4}\.\d{2}\.\d{2}$/.test(p.to)),
  JSON.stringify(d.forecast.phases[0])
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
const { survivalScene, stripScene, sceneBounds } = await import(resolve(ROOT, 'src/lib/scene.js'));

const records = JSON.parse(await readFile(resolve(ROOT, 'data/resets.json'), 'utf8')).records;
const chart = buildChartData(records, Date.now());

const WIDTHS = [320, 341, 375, 414];
const SIZES = [
  { name: '生存曲线', fn: survivalScene, height: 208 },
  { name: '点阵分布', fn: stripScene, height: 230 },
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

/* ------------------------------ 结果 ------------------------------ */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
