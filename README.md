# 等 TIBO 按按钮 · 重置观测台与时间预测

观测 OpenAI Codex 负责人 [@thsottiaux](https://x.com/thsottiaux) 的额度重置节奏，
给出**「还要等多久」的时间预测**，并把**这个预测有多准**一并公开。

预测不是承诺。所以这个项目的重点不是「猜对」，而是**让人能看见它什么时候会猜错**。

---

## 一、它给什么、不给什么

| | |
|---|---|
| **给** | 剩余等待的**中位数与分位数区间**（如「中位 0.8 天，80% 区间 0–4.6 天」） |
| **给** | 各时间窗的**发生概率**（24 小时 / 3 天 / 7 天 / 14 天 / 30 天） |
| **给** | **样本外回测成绩**：说「50% 分位」时，历史上真的命中 50% 吗 |
| **给** | **节奏趋势**：平均间隔怎么从 12.4 天降到 3.0 天 |
| **不给** | 「下次将于 X 点重置」这种确定性说法 —— 开关在 OpenAI 手里，不在推文里 |
| **不给** | 「某一天会不会发生」的判断。实测 7 天口径的 Brier skill 约等于 0，**这就是抛硬币** |

---

## 二、架构

```
   x.com/thsottiaux ──► 本机（住宅出口）· 定时任务
   （登录态 HTML，       └─ scripts/collect.mjs   采集 + 分类 + 识别信号
     CDP 驱动登录态 Chrome）  ├─ POST /api/ingest   数据直推后端（页面立刻变新）
                              └─ git push data/     推上仓库留档
                                        │
                                        ▼
             ┌──────────────────────────────────────────────────┐
             │  Docker 容器 · 境内云服务器                       │
             │  reset.example.com（Nginx 反代 + TLS）       │
             │                                                  │
             │  server/index.mjs                                │
             │    ├─ GET /            请求时用当前数据实时渲染网页 │
             │    ├─ /api/*           预测 / 信号 / 图表 / 历史   │
             │    └─ POST /api/ingest 接收本机推来的数据          │
             │                                                  │
             │  /app/data ← 挂载卷（唯一数据落点）                │
             └──────────────────────────────────────────────────┘
                       ▲                        ▲
                       │ HTTPS                  │ HTTPS
                 浏览器（主入口）           微信小程序

   GitHub Actions（只有改代码才触发；既不采集也不推数据）
     └─ build → dist/index.html（渲染失败时的兜底）+ og-image.png + Pages 异地备份
```

采集只在**一处**发生一次（本机），产物分两路走：`POST /api/ingest` 供后端落盘、
git 提交供仓库留档。两路共用同一份数据与同一套模型代码 —— 所以「页面上的数字 = API
返回的数字」是架构保证，不是靠人工比对（验收 A3）。

**网页不是构建产物。** 后端 `GET /` 读模板 + 当前 `data/` **在请求时现渲染**，调的是
构建期**同一个** `src/lib/page.mjs`。所以数据一到、刷新即新，不需要重新构建，也不需要
重启容器；CI 那条 `data/**` 触发因此被摘掉（D-025）。`dist/index.html` 只在渲染失败时
兜底，GitHub Pages 退为异地备份入口（后端域名才是主入口）。

**采集为什么不在 CI 上跑**：`x.com` 的 Cloudflare 拦的是**机房 IP 段**，不是「境外 IP」。
实测同一时刻：本机住宅出口 200（213KB 完整页面，4/4 稳定），Actions runner 403 挑战页。
所以采集由本机承担；后端只负责接收、落盘、预测、出页面与 API。

---

## 三、后端服务

**它是网页与 API 的唯一提供方** —— 网页在请求时用当前数据实时渲染（D-025）。
容器化部署见 [`docs/deploy.md`](./docs/deploy.md)。

```bash
npm start                      # 默认 8787 端口：网页 + API（内置采集默认关闭）
# 或
PORT=9000 COLLECT_INTERVAL_MIN=15 ADMIN_TOKEN=secret node server/index.mjs
```

零依赖，只用 `node:http`。因为没有依赖，「拷源码 + 启动」就是全部部署步骤 ——
没有 `npm install` 这一步，也就没有它带来的安装失败点与供应链面。
（容器镜像里同样零依赖：`src/` 与 `dist/` 拷进去就能跑，渲染逻辑在 `src/lib/`，
不依赖任何构建期包。）

### 环境变量

**服务本身**

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `DATA_DIR` | `<repo>/data` | 数据目录 |
| `COLLECT_INTERVAL_MIN` | `0` | 采集间隔（分钟）。**默认关闭** —— 本服务跑在机房出口，采集必被 Cloudflare 挑战（见下文「部署位置」）。设成正数才会启动内置调度 |
| `ADMIN_TOKEN` | 空 | 设置后 `POST /api/refresh` 需要 `Authorization: Bearer <token>` |
| `INGEST_TOKEN` | 空 | 设置后 `POST /api/ingest` 需要 `Authorization: Bearer <token>`。**境内服务必须设**，否则任何人都能往数据目录写东西 |
| `SOURCE_ACCOUNT` | `thsottiaux` | 被观测的 X 账号，换掉即可观测别的账号 |
| `SITE_URL` | 空 | 对外访问地址（如 `https://reset.example.com`），用于页面里的 `og:url` / `og:image`。不配则不输出这两条 meta —— 宁可少两条，也不给分享平台一个抓不到的地址 |

**F9 订阅消息**（四个都配齐才会启用，缺任一项则该功能静默关闭并在启动日志里说明）

| 变量 | 默认 | 说明 |
|---|---|---|
| `WX_APPID` | 空 | 小程序 AppID |
| `WX_SECRET` | 空 | 小程序 AppSecret，只存在境内部署环境里 |
| `WX_TEMPLATE_ID` | 空 | 订阅消息模板 ID |
| `WX_SUBSCRIBE_PAGE` | `pages/index/index` | 点通知后跳转的页面 |
| `WX_TEMPLATE_DATA` | 空 | 模板字段映射（JSON）。不配则用内置的 `thing1` / `time2` 映射 |

**构建期**（`node scripts/build.mjs`，不是运行期）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SITE_URL` | 空 | `og:url` / `og:image` 的绝对地址前缀。**不配则这两条 meta 不输出**，分享卡片抓不到图（验收 A10 不成立） |
| `BUILD_NOW` | 当前时间 | 固定「构建时刻」，ISO 串或毫秒时间戳。设了之后同一输入可逐字节复现 |

**CI 侧**（只构建产物 —— 既不采集也不推数据，见下文「部署位置」）

| 变量 | 说明 |
|---|---|
| `SITE_URL` | 仓库 Variable。写进 `dist/index.html` 的 `og:url` / `og:image` |
| ~~`INGEST_URL`~~ / ~~`INGEST_TOKEN`~~ | **已作废**（D-025）：数据改由本机直推后端，见下一张表 |

**本机采集侧**（自动化任务用；`push-ingest.mjs` 读它把数据直推后端）

| 变量 | 说明 |
|---|---|
| `INGEST_URL` | 后端的 ingest 地址，如 `https://reset.example.com/api/ingest` |
| `INGEST_TOKEN` | 与后端容器的 `INGEST_TOKEN` 一致（同一个随机串） |

⚠ 这两个**不在 CI 里**：凭据放在本机 `~/.tibo-ingest.env`（`chmod 600`），不进仓库。
GitHub Secrets 里原先那两个同名项可以删掉。详见 `docs/deploy.md` 第四节。

**测试脚本**

| 变量 | 说明 |
|---|---|
| `CHROME_PATH` | 指定无头 Chrome 路径（`check-layout.mjs` 用），不设则按常见路径找 |
| `DUMP_TIMEOUT_MS` | 单次无头 Chrome 运行的硬超时，默认 `60000` |

### API

| 端点 | 说明 |
|---|---|
| `GET /api/state` | 一次拿全：预测 + 统计 + 推文 + 采集错误 |
| `GET /api/prediction` | 只要预测（模型参数、概率、分位数、校准、区间、阶段、警告） |
| `GET /api/backtest?horizon=7` | 回测成绩：Brier、skill、覆盖率校准表 |
| `GET /api/chart` | 双端共用的图表数据（由 `src/lib/chart-data.js` 构建） |
| `GET /api/signals` | 信号识别结果（含「为什么没升级为明确信号」的解释） |
| `GET /api/history?limit=N` | 历史重置记录 |
| `GET /api/tweets?limit=N` | 采集到的推文 |
| `GET /api/stats` | 统计 + 采集错误明细 |
| `GET /api/health` | 存活 + 调度器状态（上次运行、下次运行、连续失败次数） |
| `POST /api/refresh` | 立即触发一次采集（受 `ADMIN_TOKEN` 保护） |
| `POST /api/ingest` | 接收本机推来的数据并落盘（受 `INGEST_TOKEN` 保护）。数据源是**本机**的采集任务 |
| `POST /api/subscribe` | F9：用工信 `code` 换 `openid` 并登记订阅 |
| `POST /api/unsubscribe` | F9：退订 |

> 网页（`GET /`）虽是端点，但不在上表：它在请求时用当前 `data/` 实时渲染整个页面，
> 不是一份读出来的静态文件。

### 部署

**完整步骤（docker + Nginx + 证书 + 校验清单 + 排障）见 [`docs/deploy.md`](./docs/deploy.md)。**

要点四条：

1. **镜像在【本机】构建好、传过去；服务器只 `docker load`** —— 服务器上不要 git、不要
   node、不要 npm，也不需要在境内网络里拉 Docker Hub。出镜像用 `scripts/ship-image.sh`，
   它默认 `--platform linux/amd64`：本机是 Apple Silicon（arm64）、服务器是 x86_64，
   而架构错了的报错只有 `exec format error`，**一个字都不提「架构」**。
2. **服务必须放在境内**（云服务器 / 容器平台）：小程序的 `request` 合法域名必须已 ICP 备案，
   而境外域名备不了案 —— 这是微信侧的硬要求，它单独就决定了服务只能落在境内。
3. **不要给服务开启内置采集** —— `COLLECT_INTERVAL_MIN` 保持默认的 `0`。云机房出口属
   **机房 IP 段**，而 x.com 的 Cloudflare 拦的正是机房 IP 段：实测同一时刻 runner 403
   挑战页（5,749 字节），本机住宅出口 200（213KB 完整页面，4/4 稳定）。
   采集交给**本机**的定时任务，采完直接 POST 到 `/api/ingest`。详见 `docs/data-source.md`。
4. **数据目录必须挂卷**（`/app/data`）。它是唯一的数据落点，不挂卷的话容器一重启就退回
   镜像里那份初始快照。容器启动脚本会在卷为空时自动填入种子数据，所以「直接 run」就可用。


> 采集失败不会污染数据：服务会保留上一份数据、把错误写进 `stats.json` 的 `errors`
> 并通过 `/api/state`、`/api/health` 暴露出来，页面上也会显形。实测过一次超时失败，
> 历史记录完好无损。

---

## 四、模型

### 为什么不能直接用平均间隔

52 个历史间隔里，**均值 6.93 天，但中位数只有 3.22 天**。均值被 49.7 天和 67.7 天两次
极端等待硬拉高了。拿均值做倒计时，在大多数情况下都会高估。

### 分段常数风险模型

把「距上次重置的已等待天数」切成若干区间，每个区间内假设风险率恒定：

1. **暴露量** `E_b` = 每个历史间隔在区间 `b` 内「活着」的天数之和
   （含尚未结束的当前间隔 —— 它是右删失观测，漏掉它会导致系统性低估风险）
2. **事件数** `N_b` = 落在区间 `b` 的已完成间隔个数
3. **收缩估计** `λ_b = (N_b + κ·λ₀) / (E_b + κ)`
   —— Gamma-Poisson 收缩。没有这一步，零事件区间会输出 `0%`，
   而实测数据里 11–13 天恰好是零事件区（只是样本少，不代表「绝不可能」）
4. **条件生存函数** `S(t) = exp(-∫ λ(u)du)`，所有概率、期望、分位数都由它推出，口径统一

### 参数与其选择依据

```
maxIntervals = 20        # 只用最近 20 个间隔训练
halfLifeDays = 45        # 且更近的样本再获得额外指数权重
```

选型判据**不是全期平均表现，而是近期表现** —— 因为在一个持续加速的过程里，
只有近期能代表未来。全量训练会把近期中位偏差推到 −2.65 天，这套参数压到 −0.60 天。

### 平移校准

模型在加速期必然滞后，于是系统性高估剩余时间。修正量由 **walk-forward 回测的残差中位数**
实时算出（当前约 −0.80 天），随数据更新自动调整，不写死。

用回测残差做校准是合法的：回测里每个预测点都**只用该时刻之前的数据**，属于样本外残差，
不是拿答案对答案。

---

## 五、回测：这个模型有多可信

跑 `npm run diagnose` 复现全部数字。

### 分位数覆盖率（校准后）

| 名义水平 | 实际覆盖 | 目标 | 判定 |
|---|---|---|---|
| 50% 分位 | **50.0%** | 50% | ✓ |
| 80% 分位 | **86.7%** | 80% | ✓ |
| 90% 分位 | 96.7% | 90% | ~（区间偏宽） |

说「中位数 0.8 天」，历史上确实有一半情况落在 0.8 天内。**这是可验证的。**

### 但概率预测没有区分度

| 预测窗口 | 基准发生率 | Brier | 盲猜基线 | skill |
|---|---|---|---|---|
| 24 小时 | 22.0% | 0.174 | 0.172 | **−1.3%** |
| 3 天 | 50.6% | 0.256 | 0.252 | **−1.6%** |
| 7 天 | 80.8% | 0.210 | 0.205 | **−2.3%** |

**skill 为负**，意思是：想判断「未来 7 天内会不会重置」，直接说「会」（基准率 80.8%）
比跑模型还准一点。

这不是实现问题，是数据性质：重置发生得太频繁，而驱动因素在模型之外。
所以页面上的概率条标注了「未校准」—— 它只提供直觉参考，**可信的是时间分位数**。

### 最反直觉的发现：节奏在持续加速

| 阶段 | 时间跨度 | n | 平均间隔 | 最大 |
|---|---|---|---|---|
| 第 1 段 | 2025-09-17 → 2026-04-28 | 18 | **12.39 天** | 67.7 天 |
| 第 2 段 | 2026-04-28 → 2026-07-25 | 18 | **4.92 天** | 18.5 天 |
| 第 3 段 | 2026-07-25 → 2026-09-12 | 16 | **3.03 天** | 8.4 天 |

平均间隔降了 76%。**任何「用历史平均值外推」的预测都会持续高估**，
而且两个极端长等待（49.7 / 67.7 天）只出现在第一阶段 —— 这在评估期造成严重偏差：
早期训练集把尾部风险率压低，而评估期再没出现过这种长静默。

---

## 六、局限（必读）

1. **模型只做历史节奏的外推，读不到原因。** 新模型发布、故障补偿、政策调整、
   发券机制切换，全都不在模型里。
2. **样本量小。** 52 个间隔，其中训练窗口内仅 19 次事件，长尾估计不稳定。
3. **加速期预测必然偏保守。** 这是可量化的（靠校准层修正），但校准本身也基于历史，
   如果节奏继续加速，预测仍会偏高。
4. **品类寿命有限。** 记录里已出现 3 次「发券型」重置，机制正从无条件撒福利转向发券，
   该现象随时可能结束。架构已按多账号设计 —— 改 `SOURCE_ACCOUNT` 即可切换观测对象，
   作品不会跟着 Tibo 一起死。
5. **采集依赖 X 页面结构。** 目前靠正则解析未登录 HTML 里的 React Server Components 载荷。
   X 改版时采集会失败（服务会记录错误并保留旧数据，但不会自动修复）。

---

## 七、数据来源

| 来源 | 用途 | 说明 |
|---|---|---|
| `x.com/thsottiaux` **登录态浏览器**（CDP 驱动） | **主链路** | 免登录、免 API Key、零成本。页面内嵌的 RSC 载荷里含推文正文与时间戳 |
| 同上的**免登录** HTML | 降级兜底 | 只覆盖最近约 7 条，会漏掉上一次重置。降级这件事写进 `tweets.json` 的 `source` / `degraded`，不假装正常 |
| `codex-resets.com/api/v1/resets` | 历史记录 | **每轮刷新并按 id 合并**（本地是缓存、上游是权威），记录内标注 `attribution`；同时用它的**完整正文**回填被 X 页面截断的长推文（见 `docs/data-source.md` §4.7） |

⚠ 主链路的**已知边界**：X 对长推文只渲染前约 280 字符，采集拿到的正文天然只有前半段 ——
而重置的宣告常在长公告的**最后一句**。补法见上表第三行。

X 官方 API 的 Basic 档要 $200/月，因此自建采集是整个项目能零成本运行的前提。

---

## 八、目录结构

```
src/lib/collect.mjs       采集 / 解析 / 分类 / 统计（CLI 与后端共用）
src/lib/predict.mjs       风险模型、回测、覆盖率检验、校准、bootstrap
src/lib/signals.mjs       重置信号识别（明确 / 线索 / 无）
src/lib/chart-data.js     从记录构建统一的图表数据（双端共用）
src/lib/scene.js          图元几何（双端共用，无渲染目标依赖）
src/lib/render.mjs        渲染层：数据 → HTML 片段（构建期与后端**共用同一套**）
src/lib/svg.mjs           图元 → SVG 序列化（render.mjs 的依赖，零依赖纯函数）
src/lib/page.mjs          页面组装：derive / renderPage / injectTokens / logoDataUri
src/index.html            页面模板（含 <!--__XXX__--> 占位符）

scripts/collect.mjs       CLI：采集 + 落盘
scripts/build.mjs         构建产物 → dist/（兜底页面 + OG 卡 + 小程序快照）
scripts/og-image.mjs      F8：SVG → 1200×630 PNG（@resvg/resvg-js）
scripts/diagnose.mjs      模型诊断：配置对比 / 覆盖率 / 校准曲线 / 分阶段
scripts/push-ingest.mjs   把采集结果 POST 到境内服务（Actions 侧调用）

scripts/ship-image.sh        出镜像：构建 → tar.gz + sha256 →（可选）scp 到服务器
scripts/fetch-base-image.sh  本机拉不到 Docker Hub 时，把目标架构的基础镜像搬进本地

server/index.mjs          HTTP 服务 + 路由 + 鉴权
server/scheduler.mjs      定时采集调度（防重叠、失败退避、状态暴露）
server/store.mjs          数据读取 + mtime 缓存 + 原子写
server/ingest.mjs         POST /api/ingest：落盘后再异步发通知
server/subscribe.mjs      F9：订阅名单持久化 + 「有新重置」判定
server/wechat.mjs         F9：access_token / code 换 openid / 发订阅消息

scripts/test-*.mjs        测试套件（signals / parse / shared / miniprogram / ingest / og /
                          subscribe / collect-warning / data-changed / secrets / ship / history）
scripts/check-consistency.mjs  A3：页面数字 ↔ API
scripts/check-layout.mjs       A7：窄屏横向溢出
scripts/acceptance.mjs         A1–A10 验收编排器

docs/PRD.md               需求基线（功能范围、验收标准、里程碑、评审记录）
docs/tech-selection.md    技术选型与部署清单
docs/deploy.md            部署步骤（docker + Nginx + 证书）与排障
docs/acceptance.md        M3 验收记录（脚本生成）
docs/decisions.md         已定的技术决策
docs/known-issues.md      已知问题
docs/model.md             模型方法论
docs/research.md          品类调研
docs/miniprogram.md       小程序上手与截图终检
```

### 一个刻意的架构决定：渲染不在浏览器里做

所有 SVG 图表和文案都在 **Node 构建期**渲染成纯 HTML，页面**不依赖运行时 JS 画图**。
浏览器里只留一个可选小脚本让倒计时跳动 —— 把它整个删掉，页面依然完整、数字依然正确。

这么做是因为踩过坑：早期版本用脚本现场画图，在限制脚本执行的预览环境里直接白屏。
现在 `dist/index.html` 出厂即完整。

构建期还有两道防呆：模板占位符缺失抛错、构建后仍有残留占位符抛错 —— 避免静默产出空白页。

---

## 九、本地运行

```bash
npm ci                     # 装唯一的构建期依赖（@resvg/resvg-js）
npm run collect            # 采集（原创 + 回复两条流；默认增量。历史记录每轮自动刷新，无需 --bootstrap）
npm run collect -- --full   # 强制全量重扫，用来补增量漏掉的洞
npm run collect -- --no-replies  # 只收原创流（排查用）
npm run build              # 构建 dist/index.html + dist/og-image.png + 两个图标
npm run refresh            # 采集 + 构建
npm start                  # 启动后端（含定时采集）
npm run diagnose           # 模型诊断与回测
npm test                   # 440 项纯函数回归（识别词表、钟点解析、跨推文聚合、增量停止、回复配对、代理探测）
```

> 采集默认收**两条流**：`/`（原创）与 `/with_replies`（原创 + 回复）——
> 他的关键承诺大量落在回复里，只收原创会整块丢掉（实测一轮回复流比原创流多 3 倍）。
> 采集默认走**增量**（翻到连续两整屏都已知即停），**每 72 小时自动全量回补一次**。
> 出口代理是**实测探测**的，不读 `HTTPS_PROXY` —— 原因见 `docs/data-source.md` §4.5。

`file://` 直接打开 `dist/index.html` 也能看，不需要起服务。

页面本身仍是**一个自包含的 HTML**（品牌标已内联成 data URI）。另出两个图标文件
`favicon.png` / `apple-touch-icon.png` —— 图标必须独立存在，因为浏览器是**自己发请求**
去取 favicon 的，内联不可靠（Safari 尤其）。少了它们页面照常显示，只是标签页没有图标。

构建与验收：

```bash
npm run check                                  # 12 个测试套件 + 构建 + A3 一致性
SITE_URL=https://<你的域名> npm run accept       # A1–A10 全量验收（会先自动重建 dist）
SITE_URL=https://<你的域名> npm run accept -- --write   # 顺带写 docs/acceptance.md
```

`npm run accept` 必须给 `SITE_URL`：A10 要判定 `og:image` 是不是绝对地址，
不知道公开域名就没法判。`npm run check` 刻意不含 A7（窄屏溢出），因为那需要本机有 Chrome。

注意 `npm run build` 若不带 `SITE_URL`，会**明确警告并跳过** `og:url` / `og:image` ——
这是有意的降级，不是 bug；线上构建（Actions）在仓库 Variables 里配了这个值。
