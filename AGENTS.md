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
4. **时间字段的措辞必须与它的真实语义一致**。`stats.json` 的 `generated_at` 是
   「采集**运行**时刻」，不是「数据新鲜度」—— 采集失败时它照样推进，所以页面与卡片上
   写的是「最近一次采集」。数据新鲜度另取 `tweets.json` 的 `updated_at`（只在采集
   **成功**时才推进）。拿前者冒充后者，就是在页面上说一句当时并不成立的话。

## 发布链的降级规则

**采集失败不得阻断发布，但也不得静默。** 数据本来就存在 `data/` 里，构建与发布并不
依赖本轮网络是否成功。所以 `collect.yml` 里「采集」与「构建页面」是**两个 step**，
采集标 `continue-on-error`，失败时给 `::warning` + step summary。

- ⛔ **禁止**把 `collect.mjs` 与 `build.mjs` 塞进同一个 `run:` 块 —— 两者共用 `bash -e`
  语义，采集一失败，构建那一行根本不执行，一次网络抖动就赔掉整条发布链
  （2026-09-21 的 403 事故：采集挂了 → build 没跑 → deploy 不执行 → 线上停在旧产物）。
- 降级的另一半在页面上：`scripts/render.mjs` 的 `renderCollectWarning` 读
  `stats.json.errors`，在页面顶部显示「数据采集异常」。少了它，降级就变成静默陈旧。
- 这两条都有回归断言，见 `scripts/test-collect-warning.mjs`。

## 数据源：出口 IP 决定采集成败

x.com 的 Cloudflare 拦的是**云机房 IP 段**，不是境外 IP。同一时刻实测：本机（住宅出口）
HTTP 200 / 213KB 完整页面 / 4 次重试全中；runner（AWS）403 挑战页。
已被证伪的绕行路径（换域名、官方嵌入接口、第三方镜像、免费代理）见 `docs/data-source.md`，
**别再重复试一遍**。

- 本机是**主链路**，CI 只是兜底。动采集相关代码时，别假设 runner 采得到。
- CI 兜底必须带 `--max-age`。否则它那次注定失败的采集会把 `errors` 写进 `stats.json`，
  让页面上刚被本机清干净的「数据采集异常」横幅又贴回来 —— 数据明明是新鲜的。
- 短路时**不写任何文件**。写了 `generated_at`（采集运行时刻）就会变，CI 会为它单独提交，
  于是每 30 分钟污染一条提交历史，而数据一个字都没动。
- CI 的提交范围**不含** `miniprogram/data/snapshot.js`。它是构建产物，内嵌了构建时刻
  （`generatedAt` / `now` 及其派生的全部预测值），每次构建都不同；提交它等于换个来源
  继续污染历史。它由本机构建后提交。
- 改 `parseTweets` 前后**必须**跑 `node scripts/test-parse.mjs`。它锁的是 RSC payload 的
  **结构契约**：`created_at_ms` 不只出现在推文上 —— 用户对象（UserCore）也带一个，
  那是账号注册时间。按索引硬配会让整条链错位一位（实测 7 条推文配 8 个时间戳），
  且不报错、不崩溃，只让页面数字悄悄错掉。该函数此前零测试覆盖。

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
npm run check                              # 8 个测试套件 + 构建 + A3 一致性（不依赖 Chrome）
SITE_URL=https://<你的域名> npm run accept  # A1–A10 全量验收（会先自动重建 dist）
```

`npm run accept` **必须给 `SITE_URL`**：A10 要判定 `og:image` 是不是绝对地址，
不知道公开域名就没法判。加 `--write` 会把结果写成 `docs/acceptance.md`。

`npm run check` 刻意不含 A7（窄屏溢出），因为那需要本机有 Chrome；CI 上也没有装。

### 单个套件

```bash
node scripts/test-signals.mjs       # 信号解析用例
node scripts/test-parse.mjs         # 推文解析：字段按对象就近配对（防时间戳错位）
node scripts/test-shared.mjs        # 共享层：图元越界 / 同步一致性
node scripts/test-miniprogram.mjs   # 小程序图元在目标尺寸下不越界
node scripts/test-og.mjs            # OG 卡：缺字体守卫 / 尺寸 / 安全区 / meta 三态
node scripts/test-ingest.mjs        # POST /api/ingest 的鉴权与落盘
node scripts/test-subscribe.mjs     # F9 订阅链路（token 缓存 / 永久失败码 / 水位线）
node scripts/test-collect-warning.mjs  # 采集异常外显 + 发布链不得被采集失败阻断
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
