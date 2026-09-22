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
  browser.mjs          ★ 登录态时间线采集（CDP 驱动 Chrome，主链路；一次会话收原创 + 回复两条流）
  predict.mjs          风险模型 / 回测 / 校准
  signals.mjs          ★ 信号识别（四档）+ 钟点解析 + 跨推文聚合（hypothesis / forecasts）
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
5. **「观测中」后面那个钟点是「现在几点」，不是「数据多新」。** 页首 `#upd` 由页面脚本
   每秒推进，静态兜底值取**构建时刻** `m.now`。注意区分三个时刻：`builtAt` 是**渲染**时刻、
   `generatedAt` 是**采集**时刻、而它要显示的是**当前**时刻 —— 前两个都不是当前时间。
   曾经这里填的是 `m.generatedAt`，于是页面上出现「观测中 · 12:59」而当时已 15:02，
   读者只能读成「现在 12:59」，第一反应是页面停更了。数据新鲜度由页脚的
   「最近一次采集 ⋯」单独承担 —— **一处只讲一件事**，不是把信息删掉。
   - ⚠ **取当前时间必须显式写 `timeZone: 'Asia/Shanghai'`**，不许读本机时钟：浏览器可能在
     任何时区。实测把浏览器强制到 `America/New_York`（偏移 −4）后，页面仍须显示北京时间。
   - 小程序侧**不用 `Intl`**（部分安卓机型不可用或不完整），走 `beijingParts` 手算 `+08:00`。
     两端格式都是 `HH:MM:SS`。
   - `.pulse #upd` 要带 `font-variant-numeric: tabular-nums`，否则秒位一跳整块胶囊就左右晃。
   - **降级态（`degraded`）是例外**：那里要传达的正是「这是什么时候的快照」，
     所以仍给数据时刻，文案两端统一为 `快照 · HH:MM`。

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
- ⛔ **降级阈值必须 ≥ 主路径的刷新周期。** `collect.yml` 的 `--max-age` 比的是「数据
  年龄」，而数据年龄从本机刚采完的 0，涨到下一轮本机采集前的**满一个周期**（现 480
  分钟）。阈值取 120 时，一个周期里有 360 分钟超阈值 → CI 每 30 分钟真去采一次、
  必然 403、必然写 `errors`、必然产生一条提交，**页面 75% 的时间挂着「数据采集异常」**。
  那面横幅于是从告警退化成了噪音 —— 真出问题时读者已经习惯它了，这比不告警更糟。
  现取 540 = 480 + 60（一轮余量）。阈值**不是手写的**：`collect.yml` 顶层 env 的
  `LOCAL_COLLECT_INTERVAL_MINUTES`（本机周期）在「采集」step 里加余量算出来 ——
  改周期只改那一处，阈值自动跟着变，不存在「两个数字要记得一起改」。
  回归断言见 `scripts/test-collect-warning.mjs`（含「`--max-age` 不许再出现字面量」），
  推导与实测见 `docs/data-source.md` §5。
- ⛔ **「有没有变化」不许用字节级判据。** `git diff --staged --quiet` 会把
  `stats.json` 的 `generated_at` / `stats.days_since_last`、`signal.json` 的
  `generatedAt` 等**每轮必变、却与数据无关**的字段当成变化，于是刷新一轮就提交一条
  —— 而数据一个字都没动。判据是 `scripts/data-changed.mjs`（退出码 0 = 有实质变化、
  1 = 只有时间戳在动）。⚠ 但 `errors` 的**首次**变化必须提交：否则「线上挂着横幅」
  在仓库里没有痕迹，下一轮从仓库检出就成了「数据陈旧但页面一切正常」——页面会说谎。
  回归断言见 `scripts/test-data-changed.mjs`。

## 数据源：主链路是本机登录态浏览器

**采集范围的红线：必须是「上一次明确重置往前 24 小时 → 现在」的全部帖子。**
未登录的 profile 首屏只给 **7 条**，而 2026-09-12 那次重置的 5 条全在 7 条之外 ——
观测台因此一次都没看见它本该盯住的那件事。所以主链路走 CDP 驱动已登录的 Chrome
（`src/lib/browser.mjs`），下界由 `resetFloorMs()` 算。改采集时不要退回「拿最新 N 条」。

x.com 的 Cloudflare 拦的是**云机房 IP 段**，不是境外 IP。同一时刻实测：本机（住宅出口）
HTTP 200 / 213KB 完整页面 / 4 次重试全中；runner（AWS）403 挑战页。
已被证伪的绕行路径（换域名、官方嵌入接口、第三方镜像、免费代理、AppleScript）
见 `docs/data-source.md`，**别再重复试一遍**。

- 本机是**主链路**，CI 只是兜底。动采集相关代码时，别假设 runner 采得到。
- 浏览器路径失败时**降级到免登录首屏**，但降级必须外显：`tweets.json` 里写
  `source: 'html'` + `degraded`，CLI 打「⚠ 降级，只有最近 7 条」。静默降级等于回到
  漏掉 09-12 那次重置的状态。
- **滚动必须小步**（一屏的 85%），不能用 `scrollTo(0, scrollHeight)`。X 的列表虚拟化，
  跳屏那一下渲染掉又卸载的条目永久丢失 —— 实测同一窗口跳屏 12 条、小步 16 条，
  不报错、不告警，只是悄悄少。
- **增量是默认，但必须周期性全量回补**（`DEFAULT_FULL_SCAN_HOURS`，默认 72 小时）。
  增量的实现是「翻到连续整屏都是已入库的推文就停」—— X 没有「给我某段时间」的查询入口，
  只能从最新往下翻，所以「只取未读部分」只能这么做。代价是它假设时间线连续且单调：
  虚拟列表抖动会丢整屏、他也会删推，这些洞**增量永远补不回来**（看到已知的就停了）。
  动这块时不要去掉全量回补，也不要改成「命中一条已知就停」。
- **回复是与原创并列的一等来源，必须收 `/with_replies`**（`collectStreams` 一次会话跑两条流）。
  他的关键承诺大量落在「他回复别人的帖子」里。实测一轮收下 **52 条回复**（覆盖 30+ 个
  被回复者），而原创流总共只有 17 条。最硬的一条是「OK fine. But it's also still coming
  in Tuesday」—— **原创流里一个字都没有**，且它本身不含额度词，靠被回复的内容
  （@udiWertheimer 的「you guys didn't ship anything」）才被读成预告。
  - **上下文必须在收割当时配对**（`pairReplyContext`）。`with_replies` 流把
    [原推文, 回复] 成对渲染，而 X 的虚拟列表滚过去就卸载 —— DOM 顺序是配对关系的
    **唯一载体**，事后再看只剩一堆散条目，配不出谁回了谁。配对结果存进 `inReplyTo`，
    识别侧（`signals.mjs` 的 `viaContext`）靠它读额度语境。
  - 配对宁可漏配也不要错配：原推文必须早于回复（挡时间倒挂），作者解析不出来的条目
    既不算他的、也不拿来当上下文。**假上下文比没有上下文更糟** —— 它会把无关推文
    的内容当成他的回复语境，直接污染识别。
  - **一条会话跑完所有流**。早先是每条流各调一次 `collectTimeline`，它会在结束时
    `close()`，于是第二条流复用到正在退出的 Chrome，撞出 `CDP 超时：Target.createTarget`。
  - 两条流失败**互不牵连**：原创流是主（挂了整轮判失败），回复流是补充（记进
    `replyError`，不判失败也不进 `errors`）。
- **回复雷达已默认关闭**（`--radar` 才开）。它当初存在的理由是「回复不进 profile 流，
  只能从别人推文的详情页里反着找」——这条前提没了。实测它对象池里只有 1 个账号、
  扫 6 条详情页命中 0，而回复流一次收 52 条。**不要把它重新打开当主路径**，
  也不要试图靠扩它的池子来提覆盖（那是绕远路：池子要人工维护，而回复流自己就带着
  「他回复了谁」）—— 留着它是为了 `with_replies` 连续失败时兜底与排查。
- **本机采集由定时任务每 8 小时触发一次**（WorkBuddy 自动化「Tibo Reset 采集（本机出口）」，
  工作目录就是这个仓库）。它只做「采集 → 构建 → 有实质变化才提交推送」，且只允许改
  `data/` 与 `miniprogram/`。**不要再叠加一个 launchd 定时任务** —— 会重复采集。
  它靠 workbuddy 在跑；这条依赖是已知边界，写在 `docs/data-source.md` §5。
- **出口代理必须实测探测**（`src/lib/proxy.mjs`），**不要读 `HTTPS_PROXY`**。
  在本机它被沙箱设成自己的出口端口（实测 57119），那个端口**连不通 x.com**（HTTP 000）。
  真实代理在 7890，不探测就发现不了。这个坑的隐蔽处在于它时好时坏：复用用户手动
  （以 7890）起的登录窗口时一切正常，一旦自己起 Chrome 就静默拿到 0 条。
- **不要用登录态路径去判断推文归属之外的东西**：免登录 HTML payload 里**混着别人的
  推文**（实测两条被记成 Tibo 的，实际分属 `@sama` 与 `@j_dekoninck`）。所以
  `foundVia: 'timeline'` 的行是低可信历史数据，`'timeline-browser'` 才可归因。
- headless 必须伪装 UA（否则 x.com 稳定 403），profile 目录必须在 `$HOME` 下
  （独立目录 + 绝不进仓库），启动要带 `--no-sandbox`。理由见 `docs/data-source.md` §4.2。
- CI 兜底必须带 `--max-age`，且阈值**必须 ≥ 本机周期**（由 `collect.yml` 顶层的
  `LOCAL_COLLECT_INTERVAL_MINUTES` 推导出来，见上文「发布链的降级规则」那条红线）。
  否则它那次注定失败的采集会把 `errors` 写进 `stats.json`，让页面上刚被本机清干净的
  「数据采集异常」横幅又贴回来 —— 数据明明是新鲜的。
- 短路时**不写任何文件**。写了 `generated_at`（采集运行时刻）就会变，CI 会为它单独提交，
  于是每 30 分钟污染一条提交历史，而数据一个字都没动。
- CI 的提交范围**不含** `miniprogram/data/snapshot.js`。它是构建产物，内嵌了构建时刻
  （`generatedAt` / `now` 及其派生的全部预测值），每次构建都不同；提交它等于换个来源
  继续污染历史。它由本机构建后提交。
- 改 `parseTweets` 前后**必须**跑 `node scripts/test-parse.mjs`。它锁的是 RSC payload 的
  **结构契约**：`created_at_ms` 不只出现在推文上 —— 用户对象（UserCore）也带一个，
  那是账号注册时间。按索引硬配会让整条链错位一位（实测 7 条推文配 8 个时间戳），
  且不报错、不崩溃，只让页面数字悄悄错掉。该函数此前零测试覆盖。
- `scripts/test-parse.mjs` 同时锁 `normalizeTimelineItems()`（去重、下界含端点）、
  `resetFloorMs()`、`isKnownScreen()`（增量的停止判据）、`pairReplyContext()`（回复与
  被回复内容的配对）与 `resolveProxy()`（代理发现）。这几处出错同样是静默少数据。

## 信号识别：四档，且已发生的重置不能被丢

`src/lib/signals.mjs` 分四档：`explicit`（预告，给时间窗口）> `occurred`（**已经发生**）
> `hint`（线索）> `none`。

**⚠ 四档是「判定」，不等于「都上页面」。** 信号区**只讲未来**：

| 档位 | 数据层 | 页面 / 小程序横幅 |
|---|---|---|
| `explicit` 预告 | 保留 | ✅ 展示（页首最大视觉重量） |
| `occurred` 已发生 | **保留**（识别 + 计数） | ❌ **不列举** —— 见下 |
| `hint` 线索 | 保留（有上限） | 仅在无预告时兜底展示一条带窗口的 |
| `none` | 保留 | 一行空闲状态，措辞是「没有检测到重置**预告**」 |

- **「已发生」不要放回页首。** 它是往回看的事实，而信号区回答的是「下一次什么时候」。
  这段事实的载体已经有三处：顶部「距上次重置 N 天」倒计时、下方「最近记录」、
  每轮采集日志。再在页首铺原文卡片，既把倒计时挤出首屏，也只是复述。**老大明确否掉过。**
  注意区分：**判定能力要保留**（它才是「不许漏检」的落点），去掉的只是**呈现**。
- **`occurred` 这一档本身不是可有可无的。** 早先的实现只找预告，把「已发生」判成
  「已完成的过去事件，不是预告」直接丢掉 —— 于是**数据里就看不见 09-12 那次重置**。
  判定层的最初动机是「不许漏检」，这个动机仍然成立。
- **`analyzeTweet` 与 `classify` 共用一份词表**（都在 signals.mjs，`collect.mjs` 的
  `classify` 只是转发）。它们曾经各持一份，结论互相打架：识别侧把
  "Reset all propagated" 丢掉，采集侧靠词表里的 `all` 把它蒙成 reset ——
  那个 all 是「全部传播完毕」，与额度无关，纯属巧合；同一天写着 "A reset" 的那条
  没有 all，就被判成 `other`。
- **不许静默截断**。`signals` / `occurred` 全量保留；`hints` / `rejected` 有上限
  （`MAX_LISTED`，2026-09-22 由 60 提到 200）但触顶会置 `truncated: true`。
  上限按**倒序**截取，触顶时丢的是**最旧**的几条。对 `rejected` 而言这个方向是安全的：
  带重置结论的推文走 `explicit` / `occurred`，而那两类不设上限。（早先的注释把
  「09-12 那条 `A reset` 被截断」记成这里的锅 —— 实测它在 `occurred` 档，从不进 `rejected`。）
  ⚠ 这**不是**「累积日志 + 淘汰最旧」：每轮在时间窗内全量重算，推文离开列表是因为
  滑出了窗，不是因为被淘汰。所以上限的真实约束是「窗内条数的峰值」，与历史总量无关。
- 时间窗写进结果（`windowFrom` / `windowTo`），可复核。下界取
  `min(now - lookbackDays, sinceMs)`：既不漏掉近期发言，也保证「上一次重置以来」整段在窗内。
  **超窗的推文只是不参与本轮判断，不会被删** —— 数据不废弃，口径按时间轴切，不按条数切。
- **回复的额度语境借自被回复的内容**（`viaContext`）。他的回复常常一个额度词都没有
  （「OK fine. But it's also still coming in Tuesday」），只有连着 `inReplyTo` 才读得出来。
  所以 `analyzeTweet` 里有 `ownIntent < 2 && ctxIntent >= 2` 这条借语境规则，判定依据里
  会写明「上下文：回复 @xxx「…」」。**它只在 `inReplyTo` 真被填上时才生效** ——
  而 `inReplyTo` 靠采集侧在收割当时配对（见上一节），两边是配套的：
  缺了一边，这些回复就退化成「一堆读不懂的半句话」。
- **一条预告 = 一个时间窗口，支撑它的推文挂在这条里面**（`forecasts`，见 D-018）。
  他习惯先铺垫、后宣布（实测 09-19 在别人的帖子底下回「still coming in Tuesday」，
  09-22 原创说「I promised a reset for Tuesday」），两条指向同一个窗口 ——
  页面上是**一条**预告，里面挂着这几条推文，不是两块横幅。
  ⚠ 合并的边界是**窗口**（`dayNum`）而不是条数：他说两个不同的日子时是**两条**预告。
  把所有 explicit 拍成一条，会在改口场景下给出一个谁也不认的时间 —— 比不合并更危险。
  ⚠ **别再往页面上加「另有 N 条…不重复列出」这类行**。那是在陈述「我做了去重」这个
  实现细节，用户既不知道是哪几条、也不知道说了什么，只知道系统藏了东西。
- **预告必须有时间窗口才算预告**。`explicit` 的准入就是「有窗口 + 有依据」，
  只有情绪没有时间的（「快了」）不算 —— 那会变成制造焦虑的假信号。
  真实数据里出现预告是**正常**的（他是真的会预告），测试断言的是准入条件，不是「不许有预告」。
- **证据条目里的时间一律换算到北京时间并写明**。旧版直接贴 `createdAt.slice(0,16)`，
  那是 **UTC**，与 `render.mjs` 顶部「所有面向用户的时间一律按 Asia/Shanghai 渲染」的
  约定自相矛盾 —— 同一条推文在页面上会有两个相差 8 小时的时间戳。
- **窗口的文案按粒度定形：具体时刻优先，区间只留给本来就含糊的粒度**（见 D-019）。
  `describeWindow()` 走三条路：`instant`（真说了钟点）两边各给一个时刻；
  当地一整天写「`2026.09.22（周二） 全天`」+ 北京只给**开启那一刻**「`15:00 起`」，
  跨自然日的事实退到 `rangeNote` 一句话；整周 / 一周内的某几天**本来就含糊**，照给区间。
  ⚠ **别把「全天」展开成 `00:00 – 23:59`**。那是把天粒度硬撑成钟点区间，读起来像
  他定在当地午夜重置 —— 凭空长出来的精度，与「假信号伤可信度」是同一条红线。
  ⚠ 「起」字不能省：省掉之后「`09.22 15:00`」会被读成「他定在 15:00 重置」。
- **「距窗口开启」的倒数两端都要有，且锚点必须写在标签上**。页首那个跳动的数字是
  「距上一次重置」——**往回看**的；往前看的这条挂在预告卡内、窗口块上方。
  只给一个跳动的数字、不写它数到哪一刻，读的人没法核对（这正是用户反馈的原话）。
  窗口开了就换文案，不再报读数。一致性校验【⑤】会把 `.sig-cd` 的 `data-from`
  按北京时间格式化，与 `.cd-anchor` 逐字比对。
- 改识别词表或判定顺序，**必须**跑 `node scripts/test-signals.mjs`；它含 09-12 那两条
  真实数据的回归（`occurred` 必须认出 2 条）、三条反例（模型权重重置、将来完成时、假设语境）
  与【6】预告合并（同窗口必须合成一条、跨窗口必须分成两条）。
  改**呈现**（哪些档上页面）则跑 `node scripts/test-miniprogram.mjs`：它在【5】与【8b】
  两处同时断言「已发生被识别」与「已发生不进横幅」，两边都要成立。

## 综合分析：时间证据要跨推文聚合，不是抓到一条 reset 就结束

老大的两条原话定了这个模块的存在理由：

> 「他不是都有 3am on a tuesday 这样的回复了吗？为什么没有明确时间」
> 「你需要做综合分析，而不是抓取到了一条 reset 信号就结束了」

`detectSignals` 除逐条判定外，还必须产出 `hypothesis`（`buildHypothesis()`）：
把指向**同一当地日历日**（`dayNum`，不是「同一个词」）的推文收成一条证据链。

- **单条判完就结束是不够的。** 「3am on a tuesday」单看确实不是承诺（他在回复
  「GPT-6 社区之夜」），但当同一天另有好几条推文各自指向同一个日期时，
  那些指向本身就是证据。**系统此前从不看推文之间的关系。**
- **证据必须分强弱，不能一锅端**：
  | 强度 | 来源 | 作用 |
  |---|---|---|
  | `hard` | `level === 'explicit'`（含额度承诺） | **决定窗口** |
  | `soft` | 只有时间、没有额度语境 | 仅作旁证，**不改窗口** |

  把 soft 也算进窗口就等于「他随口提到某个周二 → 页面报一个重置时间」，
  那正是这个产品最不能出的错。**假信号比漏检更伤可信度。**
- **聚合真正带来精度的地方是同日的多条硬证据**：一条说到「天」、一条说到「钟点」时，
  按 `PRECISION_RANK` 收敛到更精确的那条。只取「最近一条」会丢掉这个精度。
- **钟点线索要显式列出「未采用」及原因。** 「系统没看见」是缺陷，
  「看见了但判它语境无关」是判断 —— 两者可信度完全不同，页面上必须区分得开。
  `clockHints` 就是为这个留的。
  ⚠ **这条被要求改成「采纳 3am」过一次，没有照做（见 D-019）。** 实测的上下文是：
  被回复 `the GPT-6 Community Night was 🔥`，他回 `3am on a tuesday` ——
  在聊社区活动办到几点。全仓 69 条推文（含 52 条回复的被回复原文）里只有 **2 处钟点**
  （这一处 + `11pm on a Tuesday, big startup energy`），**没有一处与额度同段**；
  53 次历史重置又均匀铺在 19 个小时上，也没有可用的默认钟点。
  所以「采纳它」等于把一句聊聚会的话写成「重置在 09-22 18:00」。
  **要改这条必须先拿出额度语境里的钟点，别只把 `adopted` 翻成 true。**
- **含糊的裸星期要标待考。** 裸星期（「a Tuesday」）天然有两种解读：周三说
  「11pm on a Tuesday」既可能指刚过去的周二、也可能指下一个。`candidateWindow.note`
  带着这个歧义提示，聚合时据此判断它是确定证据还是待考证据。

### `hypothesis` 的下游是 `forecasts`（呈现层只认后者）

`buildHypothesis` 回答的是「凭什么说这个时间」；`buildForecasts(signals, hypothesis)`
把它和预告**绑在一起**，产出「一条预告 + 里面 N 条推文」（见 D-018）。
渲染层（`render.mjs` / `miniprogram/utils/view.js` / 采集日志）**只读 `forecasts`**，
不自己拼装、不自己去重 —— 两边各算各的正是本项目反复吃过亏的地方（词表分裂、
时间戳口径不一致）。

- `buildHypothesis` **只锚定一个日子**（`dayNum`），所以当存在第二个未来窗口时，
  该窗口在 `forecasts` 里退化为**单条证据**（`asEvidence`）。结构一致，渲染层不写两套。
- 改呈现结构后要同时看两端：网页断言在 `test-signals.mjs【6】`，
  端上断言在 `test-miniprogram.mjs【5】`。

### 时间线索一律不许丢

`intent < 2`（有时间、无额度语境）的分支**不再**把 `window` 置空就结束，
而是保留 `candidateWindow`（词、精度、`dayNum`、歧义 note）。
旧版丢掉的后果很实在：事后既无法复核「系统看到了什么时间」，
也无法把它拿去做聚合 —— 老大问的「为什么没有明确时间」就答不出来。

### 两个踩过的坑（改时间解析前必读）

1. **`SPEC` 必须显式传，不能靠默认值。** `push()` 的默认 `spec` 是
   `SPEC.weekend`(28) —— 即「最含糊」。星期分支与「月+日」分支都曾漏传，
   后果不只是排序错：`future` 过滤对 `spec ≤ VAGUE_SPEC` 的表达要求
   「窗口过半还没过」，于是**当天下午说「reset on Tuesday」会因为当天窗口已过半
   而被整条丢掉**。他大量时间线索就是这么给的（裸星期 + 钟点）。
2. **「A reset」这种名词化陈述，只有在句中看不出未来时间时才等于「已发生」。**
   `"I promised a reset for Tuesday"` 形态上完全符合名词化陈述，但它是**承诺**。
   闸门是 `occurredShape && !future.some(w => w.spec > VAGUE_SPEC)`。
   此前这条之所以没暴露，是因为真实那句话里恰好有 "See you soon" 命中了
   `RE_FUTURE` 才侥幸走对分支 —— **靠巧合成立，不是判据成立**。
   用 `> VAGUE_SPEC` 而非「有没有时间词」：含糊的 this week 不足以推翻一条
   明确的已完成陈述。

### 钟点解析（此前完全缺失）

`parseTimes` 的第 7 类：`3am` / `11pm` / `3:30pm` / `midnight` / `noon` → `precision: 'instant'`。

- **钟点与同句的日期是一个整体**，必须合并且以钟点为准（`SPEC.clockInDay` = 96）。
  否则会同时产出「周二全天」和「某一个 3am」两个窗口，而排序会让那个
  **没有日期约束**的 3am 抢先 —— 那是错的。
- 句中**没有**日期时，钟点才自行取「最近的未来那一刻」。
- 钟点**不能**把没有额度语境的推文送上信号位（`intent < 2` 的准入仍然管用）。

改这一块**必须**跑 `node scripts/test-signals.mjs` 的【3b】与【5】两段。

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
