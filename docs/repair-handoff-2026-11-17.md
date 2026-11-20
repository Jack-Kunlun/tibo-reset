# 2026-11-17 修复交接

代码位于当前工作区，尚未提交、推送、部署或发布小程序。`miniprogram/config.js` 与 `docs/wechat-operations/` 是既有用户工作，本次不纳入修改。

## 生效范围

- 网页：`src/index.html`、`src/lib/render.mjs` 消除桌面预测卡与依据卡之间的网格空洞；桌面依据横排，最近记录独立整行。月份只显示年月、箭头居中，时区仍明确。
- 网页/API/采集：`src/lib/signals.mjs` 修正 Perhaps/Maybe 试探语气。后端更新即按新逻辑推导；本机下一轮采集也会重算信号，无需手改信号快照。
- 本机采集：`src/lib/collect.mjs`、`browser.mjs`、`scripts/collect.mjs`、`scripts/data-changed.mjs` 记录双时间线到界证明。**仅更新服务器不会修复本机采集器**，自动化必须使用当前工作区中的新代码。没有改自动化排期，也没有叠加定时器。
- 小程序：记录页 WXML、`styles/design.wxss`、`utils/view.js`、`utils/dashboard.js` 修改月份控件，需重新上传小程序包才生效。验收包含 WXML/WXSS 浏览器预览，不等于微信真机发布验收。

## 人工记录更正

11 月 13 日的错误属于运行数据，换镜像不会自动更正。脚本只改已知账本条目的类型，保持 ID、原帖、到账时刻、备注和原有审计历史；不能把整个本地 data 目录覆盖到服务器卷。

先预览：

```sh
node scripts/correct-banked-reset.mjs --url=https://reset.petcare-home.com
```

执行同一条记录的更正：

```sh
node scripts/correct-banked-reset.mjs --url=https://reset.petcare-home.com --apply
```

预期：目标从 `reset` 变为 `credit`；11 月仍为 3 次到账，分类变为 0 次重置、3 次发券。若此后新增到账，以当时总数为准。重复执行不新增修订；目标被改过或 revision 冲突则停止，不自动覆盖。此次已经在隔离账本和真实本地管理接口完成演练，未对线上执行写入。

## 完整补采的验收口径

先确认 WorkBuddy 没有同时采集，再运行需要的手动全量采集：

```sh
node scripts/collect.mjs --full
```

全量默认最多滚动 400 步、每步等待 2 秒；日常增量保持 60 步、800 毫秒。显式 `--max-steps` 优先。只有输出「原创与回复均到达」且 `stats.full_scan` 的两个流都有到界证明才可记作全量完成。置顶/转发提示条目仍收录，但不参与到界证明，防止首屏旧置顶帖令采集提前结束。`no-more`、`exhausted`、未登录、关闭回复或回复异常都不推进完整成功水位。采得的帖子照常保留；未完成原因保存在 `collect.fullScan` 和 `full_scan_attempt`，6 小时后可自动重试。历史未认证的 `last_full_at` 不作为完成证据。此次没有启动真实 X 补采，不能把代码验证写成历史数据已经全部补齐。

## 本地验证

信号及重置回放、采集健康及解析、数据变更判据、人工账本更正、网页计划及自动刷新、月历日期、小程序记录页及预览、共享同步检查和构建均采用定向验证。桌面 851/1024/1440/1920px 与移动 390/768/850px 实测；桌面预测卡至依据卡间距 22px，页面无横向溢出；网页和小程序预览箭头纵向偏差均为 0。独立审查未发现剩余阻断问题；启动异常未记录失败冷却、尾随 Maybe 误入账等审查发现均已修复并复测。

置顶标记及双流深扫已用模拟 DOM/CDP 验证，仍需真实 X 运行确认页面结构和耗时。双流各 400 步、每步 2 秒的最大滚动等待约 27 分钟，另有页面启动与正文补全时间；不要让手动采集与 WorkBuddy 同时写数据。
