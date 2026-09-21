# AGENTS.md — 本仓库的工程约定

给未来的协作者（人或 AI）看。**动手前先读这里和 `docs/decisions.md`。**

## 目录

```
data/                运行期数据（产品本体，纳入版本管理）
  resets.json        重置事件记录（cold start 回填 + 后续自建采集）
  tweets.json        推文快照
  stats.json         统计 + 采集错误
  signal.json        信号识别结果（由采集阶段产出；只做过冷启动回填、还没跑过采集时不存在）
  subscriptions.json F9 订阅名单（含 openid）—— 已 gitignore，**绝不能提交**
dist/                网页构建产物（不纳入版本管理）
docs/                需求 / 调研 / 决策 / 选型 / 验收
  PRD.md               需求基线（功能范围 F1–F12、验收 A1–A10、里程碑）
  tech-selection.md    技术选型与部署清单
  acceptance.md        M3 验收记录，由 scripts/acceptance.mjs --write 生成，勿手改
  miniprogram.md       小程序上手与截图终检步骤
scripts/             构建 / 采集 / 渲染 / 诊断 / 验收 / 测试（Node，直接跑）
server/              后端服务（零依赖，node:http）
  index.mjs            路由 + 鉴权 + 启动
  scheduler.mjs        定时采集调度（防重叠、失败退避、状态暴露）
  store.mjs            数据读取 + mtime 缓存 + 原子写
  ingest.mjs           POST /api/ingest：境外 Actions → 境内落盘
  subscribe.mjs        F9 订阅名单持久化与「新重置」通知
  wechat.mjs           微信 access_token / openid / 订阅消息（零依赖 fetch）
src/index.html       网页模板（含 <!--__KEY__--> 占位符）
src/lib/             共享逻辑（纯 JS）
  collect.mjs          采集（CLI 与后端共用）
  predict.mjs          风险模型 / 回测 / 校准
  signals.mjs          重置信号识别
  chart-data.js        ★ 从记录构建统一图表数据（双端共用）
  scene.js             ★ 图元几何（双端共用，无渲染目标依赖）
miniprogram/         微信小程序
  utils/scene.js       由 scripts/build.mjs 从 src/lib/scene.js 同步，勿手改
  utils/subscribe.js   F9 一次性订阅的客户端封装（一次授权 = 一次通知）
  data/snapshot.js     由构建写入的数据快照（离线首屏用）
```

## 语言与模块规范

- 全部 **ESM**（`package.json` 里 `"type": "module"`），Node 侧文件用 `.mjs`。
- `src/lib/` 下被小程序复用的文件用 **`.js`**，因为小程序编译 ESM 语法但正常不认 `.mjs`。
- **零运行时依赖**，不要为了省事引库。前端图表手写，后端只用 `node:http`。
- 唯一的例外是**构建期**依赖 `@resvg/resvg-js`（把 OG 卡的 SVG 转成 PNG）。
  它是 devDependency，不进运行时；不要再加第二个。
- 注释写中文，解释**为什么**，不解释 what。WIP 阶段不写大段注释，只在最终共享时补齐。

## 共享代码的同步规则

`src/lib/scene.js` 是唯一真源。`npm run build` 会把它复制到 `miniprogram/utils/scene.js`，
并在文件头写入「此文件由构建同步，勿手改」。

- 构建期会校验两侧内容一致，不一致直接抛错。
- **不要**直接编辑 `miniprogram/utils/scene.js`。
- 几何函数必须接受 `{ width, height, fontScale }`，不得写死像素尺寸 ——
  桌面 900px 的布局等比缩到手机 345px 会让图内文字变成 4px，等于没有。

## 用户可见文案的红线

1. **不出现版本痕迹**（v0.1 / v0.2 / 「本次更新」/「上一版」）。版本只存在于 git 和 README。
2. **不出现关于模型自身的元叙述**（如「本模型不预测 X，只回答 Y」）。
   数字和单位可以留，解释「为什么这个数字可信」的散文删掉。
3. 需要披露的**数据**（覆盖率、区分度、样本量）必须留 —— 那是数字，不是散文。

## 构建期的两个环境变量

| 变量 | 作用 | 不设的后果 |
|---|---|---|
| `SITE_URL` | 决定 `og:url` / `og:image` 的绝对地址 | 这两条 meta **不输出**（平台抓不到相对地址），A10 不成立 |
| `BUILD_NOW` | 固定「构建时刻」（ISO 串或毫秒时间戳） | 用当前时间。设了之后同一输入可**逐字节复现** —— A8 的时区判等就靠这个 |

后端与采集侧还有自己的环境变量（`PORT` / `DATA_DIR` / `COLLECT_INTERVAL_MIN` /
`ADMIN_TOKEN` / `SOURCE_ACCOUNT` / `INGEST_URL` / `INGEST_TOKEN` / `WX_*`），
完整清单见 README「环境变量」。

## 提交规范

- conventional commits：`type(scope): desc`，分支 `type/desc`。
- 线性合入，不用 merge commit。
- 提交前排除临时目录与缓存。

## 验证配方（本机可复现，勿凭感觉判断）

### 一次跑完

```bash
npm run check                              # 6 个测试套件 + 构建 + A3 一致性（不依赖 Chrome）
SITE_URL=https://<你的域名> npm run accept  # A1–A10 全量验收（会先自动重建 dist）
```

`npm run accept` **必须给 `SITE_URL`**：A10 要判定 `og:image` 是不是绝对地址，
不知道公开域名就没法判。加 `--write` 会把结果写成 `docs/acceptance.md`。

`npm run check` 刻意不含 A7（窄屏溢出），因为那需要本机有 Chrome；CI 上也没有装。

### 单个套件

```bash
node scripts/test-signals.mjs       # 信号解析用例
node scripts/test-shared.mjs        # 共享层：图元越界 / 同步一致性
node scripts/test-miniprogram.mjs   # 小程序图元在目标尺寸下不越界
node scripts/test-og.mjs            # OG 卡：缺字体守卫 / 尺寸 / 安全区 / meta 三态
node scripts/test-ingest.mjs        # POST /api/ingest 的鉴权与落盘
node scripts/test-subscribe.mjs     # F9 订阅链路（token 缓存 / 永久失败码 / 水位线）
node scripts/check-consistency.mjs  # A3：页面数字 ↔ API
node scripts/check-layout.mjs       # A7：窄屏横向溢出（需要 Chrome）
node scripts/diagnose.mjs           # 复现全部回测与校准数字
```

### 无头 Chrome：两个必须知道的坑

**坑一：`--dump-dom` 输出完 DOM 后进程不退出。** macOS + Chrome 153 实测：
DOM 早就完整写进 stdout 了，主进程却一直挂着（曾因此空转 24 分钟才发现）。
所以判定结束**不能**等 exit 事件，要盯 stdout 里的收尾标签 `</html>`，见到就主动收掉进程组；
另外必须挂一个硬超时兜底（`DUMP_TIMEOUT_MS` 可覆盖，默认 60s）。
实现见 `scripts/check-layout.mjs` 的 `dumpDom()`。

**坑二：无头窗口有约 485px 最小宽度。** 传 `--window-size=420` 会按 485 排版却只截 420px，
**看起来像溢出其实不是**。要测真正的窄屏，用 **iframe 固定宽度** ——
iframe 的视口宽度就等于它的 CSS 宽度，媒体查询会按真实窄屏生效。
`scripts/check-layout.mjs` 就是这么做的，判据是 `documentElement.scrollWidth ≤ clientWidth`。

截图（本机有 Chrome，不需要装 Chromium）：

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1180,1000 \
  --screenshot=/tmp/shot.png "file://$PWD/dist/index.html"
```

看页面下半部分：`sed` 注入 `body{transform:translateY(-Npx)}` 生成偏移视图，不要装图像库。

**验证脚本被禁用时页面是否完整**：剥离 `<script>` 块后重新截图。
`--blink-settings=scriptEnabled=false` **不可靠**（它不产出截图）。

### OG 分享卡的两个静默陷阱

- **字体**：resvg 找不到 CJK 字体时**不报错**，只是把汉字画成一排空方框 —— 静默产出一张坏卡片。
  `scripts/og-image.mjs` 因此在出图前探测字体，找不到就**拒绝出图**并返回 null；
  CI 侧再额外装 `fonts-noto-cjk`（带 `continue-on-error`，装不上也不至于让采集整条挂掉）。
- **字号**：`scene.js` 里的图内文字是**绝对字号**（宽版 11px）。按 1000px 宽直接出图，
  缩到缩略图只剩 4–5px。正确做法是**按 760px 宽渲染、再 `scale()` 放大到 1000**。

### 小程序

无法在本机无头运行微信开发者工具（需登录）。因此用两道替代校验：

```bash
node scripts/test-miniprogram.mjs   # 用小程序尺寸跑图元，断言坐标不出界、无 NaN
node --check miniprogram/pages/index/index.js   # 逐文件语法检查
```

截图终检需要在微信开发者工具里做，见 `docs/miniprogram.md`。

## 工具使用的坑（踩过，别再踩）

**同一文件的多个编辑不要在同一条消息里并行发送** —— 实测 6 处编辑只保住 1 处，
其余静默丢失（工具均返回「成功」），直到构建报错才发现。
同一文件多处修改要么串行，要么直接整文件重写。
