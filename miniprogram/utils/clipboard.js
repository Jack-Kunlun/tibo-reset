/**
 * 复制文本到剪贴板。
 *
 * 为什么复制要单独有个 fail 兜底：`wx.setClipboardData` 是**隐私接口**。
 * 微信官方《小程序用户隐私保护指引内容介绍》的接口映射表里，它是和
 * `wx.getClipboardData` 一起挂在「读取你的剪切板」这一条下的（写与读被合并
 * 归类，措辞粗糙但确实如此）。未在指引里声明（errno 112）或用户拒绝授权
 * （errno 103/104）时，**success 不会触发**。
 *
 * 而界面上只显示「复制原推链接」四个字，URL 本身并不渲染 —— 所以没有 fail
 * 分支时，用户拒绝授权后点击的表现是：不报错、不提示、什么都没有。链接既
 * 看不到也复制不到，且没有任何线索说明为什么。这是典型的静默失效。
 *
 * 集中在这里而不是在两个调用点各写一份，是为了避免日后改文案时只改一处
 * （首页 index 与历史页 history 各有一处「复制原推链接」）。
 */

/** 复制成功/失败都给一句用户看得懂的提示；url 为空时静默返回，不打扰。 */
export function copyText(url) {
  if (!url) return;
  wx.setClipboardData({
    data: url,
    success: () => wx.showToast({ title: '链接已复制', icon: 'none' }),
    fail: (err) => wx.showToast({ title: copyFailText(err), icon: 'none' }),
  });
}

/**
 * 把失败原因翻译成一句用户能照着做的话。
 *
 * 两类要分开，因为**用户能做的事不一样**：
 *   · 用户拒绝过授权（103/104）→ 他有权改主意，告诉他再点一次；
 *   · 开发者没声明（112）/ 未知失败 → 用户做什么都没用，别把锅推给他去点隐私弹窗。
 */
export function copyFailText(err) {
  const msg = (err && err.errMsg) || '';
  const code = err && err.errno;
  if (code === 112 || /not declared/i.test(msg)) {
    // 小程序管理后台「设置-服务内容声明-用户隐私保护指引」里没声明剪贴板。
    // 补声明约 5 分钟后生效，期间用户的复制功能一直是坏的。
    return '复制失败，请稍后重试';
  }
  if (code === 103 || code === 104 || /privacy/i.test(msg)) {
    // 官方隐私弹窗被拒后 10 秒内不会再弹，所以「再点一次」是可执行的。
    return '需要同意隐私授权，请再点一次';
  }
  return '复制失败，请稍后重试';
}
