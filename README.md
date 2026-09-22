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
                    ┌─────────────────────────────────────┐
   x.com/thsottiaux │  GitHub Actions（境外 runner）       │
        │           │  scripts/collect.mjs                │
        ▼           │        src/lib/collect.mjs          │
   未登录 HTML       └──────────────┬──────────────────────┘
   （内嵌 RSC 载荷）                 │ 解析 + 分类 + 合并
        │                          ▼
        └──► 正则抽取 ──────► data/resets.json
                               data/tweets.json
                               data/stats.json
                                    │
                                    ▼
                        src/lib/predict.mjs
                  分段常数风险模型 + 样本外平移校准
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
        scripts/build.mjs                  server/index.mjs
    （构建期预渲染 + 出 OG 分享卡）          （HTTP API + 订阅通知）
                    │                               ▲
                    ▼                               │ POST /api/ingest
          dist/index.html ────────────────────────► │
        （单文件、无运行时依赖）                     │
                    │                               ▼
                    ▼                       小程序 / GET /api/state
        GitHub Pages（作品集入口）
        境内镜像（对外分享用这个域名）
```

采集只在**境外**发生一次，产物分两路走：git 提交供 GitHub Pages 构建，
`POST /api/ingest` 供境内服务落盘。两路共用同一份数据与同一套模型代码 ——
所以「页面上的数字 = API 返回的数字」是架构保证，不是靠人工比对（验收 A3）。

`x.com` 在境内不可直连（实测 3/3 超时），所以采集不能放在境内主机上跑；
境内那份服务只负责读数据、算预测、出 API、发订阅通知。

---

## 三、后端服务

```bash
npm start                      # 默认 8787 端口，自动开始定时采集
# 或
PORT=9000 COLLECT_INTERVAL_MIN=15 ADMIN_TOKEN=secret node server/index.mjs
```

零依赖，只用 `node:http`。因为没有依赖，部署到境外小机器时不会有安装失败风险。

### 环境变量

**服务本身**

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `DATA_DIR` | `<repo>/data` | 数据目录 |
| `COLLECT_INTERVAL_MIN` | `30` | 采集间隔（分钟）。设为 `0` 关闭内置调度，改由外部计划任务调用 `POST /api/refresh` |
| `ADMIN_TOKEN` | 空 | 设置后 `POST /api/refresh` 需要 `Authorization: Bearer <token>` |
| `INGEST_TOKEN` | 空 | 设置后 `POST /api/ingest` 需要 `Authorization: Bearer <token>`。**境内服务必须设**，否则任何人都能往数据目录写东西 |
| `SOURCE_ACCOUNT` | `thsottiaux` | 被观测的 X 账号，换掉即可观测别的账号 |

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

**采集端**（GitHub Actions 侧）

| 变量 | 说明 |
|---|---|
| `INGEST_URL` | 境内服务的 ingest 地址，如 `https://api.example.com/api/ingest` |
| `INGEST_TOKEN` | 与境内服务的 `INGEST_TOKEN` 一致 |

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
| `POST /api/ingest` | 接收境外 Actions 推来的数据并落盘（受 `INGEST_TOKEN` 保护） |
| `POST /api/subscribe` | F9：用工信 `code` 换 `openid` 并登记订阅 |
| `POST /api/unsubscribe` | F9：退订 |

### 部署位置是硬约束（已实测）

**x.com 在中国境内无法直连。** 实测（广州，连续 3 次探测）：x.com 全部超时失败
（`http=000`，各 15.5s），同期 github.com、codex-resets.com 均可达。所以采集**不能**在国内主机上跑。

两条可行路径：

| 方案 | 做法 | 成本 |
|---|---|---|
| **A. GitHub Actions + 静态托管**（推荐） | 用 `.github/workflows/collect.yml`（runner 在境外）每 30 分钟采集 → 重建页面 → 提交。页面挂 GitHub Pages 或任意静态托管 | 免费、免备案 |
| **B. 境外单机** | `docker build` 后跑 `server/index.mjs`，内置调度器负责采集，顺带提供 API | 一台最小境外 VPS |

如果坚持把服务放在境内：把 `COLLECT_INTERVAL_MIN=0` 关掉内置调度，由方案 A 负责采集，
本服务只读数据、算预测、出 API。

> 采集失败不会污染数据：服务会保留上一份数据、把错误写进 `stats.json` 的 `errors`
> 并通过 `/api/state`、`/api/health` 暴露出来。实测过一次超时失败，历史记录完好无损。

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
| `x.com/thsottiaux` 未登录页面 | **主链路** | 免登录、免 API Key、零成本。页面内嵌的 RSC 载荷里含推文正文与时间戳 |
| `codex-resets.com/api/v1/resets` | 历史回填 | 仅冷启动用一次，记录内标注 `attribution` |

X 官方 API 的 Basic 档要 $200/月，因此自建采集是整个项目能零成本运行的前提。

---

## 八、目录结构

```
src/lib/collect.mjs       采集 / 解析 / 分类 / 统计（CLI 与后端共用）
src/lib/predict.mjs       风险模型、回测、覆盖率检验、校准、bootstrap
src/lib/signals.mjs       重置信号识别（明确 / 线索 / 无）
src/lib/chart-data.js     从记录构建统一的图表数据（双端共用）
src/lib/scene.js          图元几何（双端共用，无渲染目标依赖）
src/index.html            页面模板（含 <!--__XXX__--> 占位符）

scripts/collect.mjs       CLI：采集 + 落盘
scripts/build.mjs         构建期预渲染 → dist/index.html（含 OG 卡与数据摘要）
scripts/render.mjs        所有渲染逻辑（在 Node 里跑，不在浏览器里）
scripts/og-image.mjs      F8：SVG → 1200×630 PNG（@resvg/resvg-js）
scripts/diagnose.mjs      模型诊断：配置对比 / 覆盖率 / 校准曲线 / 分阶段
scripts/push-ingest.mjs   把采集结果 POST 到境内服务（Actions 侧调用）

server/index.mjs          HTTP 服务 + 路由 + 鉴权
server/scheduler.mjs      定时采集调度（防重叠、失败退避、状态暴露）
server/store.mjs          数据读取 + mtime 缓存 + 原子写
server/ingest.mjs         POST /api/ingest：落盘后再异步发通知
server/subscribe.mjs      F9：订阅名单持久化 + 「有新重置」判定
server/wechat.mjs         F9：access_token / code 换 openid / 发订阅消息

scripts/test-*.mjs        测试套件（signals / shared / miniprogram / ingest / og / subscribe）
scripts/check-consistency.mjs  A3：页面数字 ↔ API
scripts/check-layout.mjs       A7：窄屏横向溢出
scripts/acceptance.mjs         A1–A10 验收编排器

docs/PRD.md               需求基线（功能范围、验收标准、里程碑、评审记录）
docs/tech-selection.md    技术选型与部署清单
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
npm run collect            # 采集（首次加 --bootstrap 做历史回填）
npm run build              # 构建 dist/index.html + dist/og-image.png + 两个图标
npm run refresh            # 采集 + 构建
npm start                  # 启动后端（含定时采集）
npm run diagnose           # 模型诊断与回测
```

`file://` 直接打开 `dist/index.html` 也能看，不需要起服务。

页面本身仍是**一个自包含的 HTML**（品牌标已内联成 data URI）。另出两个图标文件
`favicon.png` / `apple-touch-icon.png` —— 图标必须独立存在，因为浏览器是**自己发请求**
去取 favicon 的，内联不可靠（Safari 尤其）。少了它们页面照常显示，只是标签页没有图标。

构建与验收：

```bash
npm run check                                  # 6 个测试套件 + 构建 + A3 一致性
SITE_URL=https://<你的域名> npm run accept       # A1–A10 全量验收（会先自动重建 dist）
SITE_URL=https://<你的域名> npm run accept -- --write   # 顺带写 docs/acceptance.md
```

`npm run accept` 必须给 `SITE_URL`：A10 要判定 `og:image` 是不是绝对地址，
不知道公开域名就没法判。`npm run check` 刻意不含 A7（窄屏溢出），因为那需要本机有 Chrome。

注意 `npm run build` 若不带 `SITE_URL`，会**明确警告并跳过** `og:url` / `og:image` ——
这是有意的降级，不是 bug；线上构建（Actions）在仓库 Variables 里配了这个值。
