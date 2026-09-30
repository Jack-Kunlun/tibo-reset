/**
 * 分享内容 + 分享引发的单页模式适配。
 *
 * 为什么这两件事挤在一个文件里：**单页模式只由「分享到朋友圈」产生** ——
 * 不做朋友圈分享，这个场景根本不存在。它们是同一个功能的进出两端。
 *
 * 「分享出去」那一侧（`indexShareTitle` / `historyShareTitle`）是纯函数，
 * 能在 Node 里直接喂数据回归；「被分享进来」那一侧（`isSinglePage`）只读一次
 * 宿主信息，读不到就按普通模式处理。
 */

import { elapsed } from './format.js';

/** 冷启动、或拿不到任何状态时的兜底标题。与导航栏标题同源。 */
const FALLBACK_TITLE = '等 TIBO 按按钮 · 额度重置观测台';

/** 朋友圈单页模式的场景值。官方文档《分享到朋友圈 → 页面适配》。 */
const SCENE_SINGLE_PAGE = 1154;

/**
 * 首页分享标题。
 *
 * 微信分享卡片的标题**只有一行**，超长会被截断 —— 所以这里要压进 15 字左右，
 * 而不是把页面标题原样搬过去。两态与页首口径对齐（页首讲什么，分享就说什么）：
 *
 *   · 有**明确预告** → 讲「下一次什么时候」（可行动的那条）
 *   · 没有预告       → 讲「已经等了多久」
 *
 * ⚠ 两条不能混：
 *   1. **线索（hint）档不得套用预告句式。** `view.js` 里 `signalView` 同样会挂
 *      `headline`（线索也有窗口），只看 `headline` 在不在就把「Tibo 预告：周二
 *      可能重置额度」发出去，是**把旁证说成承诺** —— 项目里 hint 从来不是承诺。
 *      所以判据是 `level === 'explicit'`，不是 `headline` 存不存在。
 *   2. **不用否定式当标题。** 没有预告时写「未检测到重置预告」是在替一个还没
 *      进来的人总结内容，而且和页首空闲态那句（「没有检测到重置**预告**」）
 *      不是一个口径。这时「等了 N 天」本身就是内容。
 */
export function indexShareTitle({ signal, lastAt, now = Date.now() } = {}) {
  const isForecast = !!(signal && signal.show && signal.level === 'explicit');
  const big = isForecast && signal.headline ? signal.headline.big : '';
  if (big) return `Tibo 预告：${big}可能重置额度`;

  if (Number.isFinite(lastAt) && lastAt > 0) {
    const el = elapsed(lastAt, now);
    // 与页首 `sinceText` 同一档说法（「已过不足一天」/「已过 N 天」），
    // 否则同一件事在分享卡片和页面上会是两种措辞。
    return `距上次重置 ${el.d < 1 ? '不足一天' : el.d + ' 天'}，还在等`;
  }
  return FALLBACK_TITLE;
}

/**
 * 历史页分享标题。
 *
 * `mean` 是页面 `data.mean` 里那个**已经 toFixed(1) 过的字符串** —— 这里再算一遍
 * 就会出现「页面上 8.4、分享卡片里 8.44」这种同一屏两个数的情形。
 */
export function historyShareTitle({ count, mean } = {}) {
  if (!Number.isFinite(count) || count <= 0) return 'TIBO 额度重置历史';
  return `${count} 次重置 · 平均间隔 ${mean} 天`;
}

/**
 * 当前是不是「分享到朋友圈」的单页模式（scene 1154）。
 *
 * 官方文档《分享到朋友圈 → 单页模式下的限制》里有一批被禁的能力，其中三处
 * 正好落在本项目的页面上 —— 不区分的话，从朋友圈进来的用户会看到一个
 * 「点了弹一句『请前往小程序使用完整服务』」的页面：
 *
 *   · 设备 → 剪贴板          首页与历史页的「复制原推链接」
 *   · 组件 → navigator       两页页脚的互相跳转
 *   · 开放接口 → 登录         F9 提醒（`subscribeOnce` 先走 wx.login，单页模式无登录态）
 *
 * ⚠ 优先用 `getEnterOptionsSync`（2.20.1+）而不是 `getLaunchOptionsSync`：
 *   后者只反映**冷启动那一次**。用户先正常打开小程序（scene 1001）、再点朋友圈
 *   链接进来时，它依然返回 1001，于是这一整页的适配全部失效 —— 而这条路径
 *   （先自己看过、再从朋友圈点回来）恰恰是最常见的一种。
 *
 * 判断不出来时返回 false（按普通模式处理）：宁可在真·单页模式下多显示两个
 * 按钮（点了会被微信拦下并提示），也不要让正常用户以为功能被砍了。
 */
export function isSinglePage() {
  try {
    if (typeof wx === 'undefined') return false;
    const api = wx.getEnterOptionsSync || wx.getLaunchOptionsSync;
    if (typeof api !== 'function') return false;
    const opts = api.call(wx) || {};
    return Number(opts.scene) === SCENE_SINGLE_PAGE;
  } catch (e) {
    return false;
  }
}
