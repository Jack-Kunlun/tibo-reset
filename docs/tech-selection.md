# 技术选型

> M2 交付物。输入是 `PRD.md`（需求基线，已确认）与 `decisions.md`（已有决策记录）。
> 本文给出**确定结论**，并记录被否掉的选项与理由 —— 便于将来有人问「为什么不用 X」。

---

## 一、选型的输入

### 1.1 硬约束（不可协商）

| # | 约束 | 来源 | 影响 |
|---|---|---|---|
| C1 | `x.com` 在中国境内**不可直连**（实测 3/3 超时，`http=000`） | 实测 | 采集必须在境外执行 |
| C2 | 小程序的 `request` 合法域名**必须已 ICP 备案**且走 HTTPS | 微信侧硬要求 | 小程序后端必须在境内、有备案域名 |
| C3 | 定位是**作品 + 引流**，不是商业产品 | PRD 1.1 | 成本趋零优先于性能与扩展性 |
| C4 | 受众在国内（同行 / 招聘方 / 内容创作者） | PRD 二 | 分享链接的**国内可达性**是效果前提 |
| C5 | 事件驱动型工具，用户平均 8 天才想起一次 | PRD 二 | 不投入留存类基础设施；分享物料的价值高于日活 |

### 1.2 已确认的资源

| 资源 | 状态 | 用途 |
|---|---|---|
| 境内服务器 | 已有 | 小程序后端 + 网页镜像 |
| 已备案域名 | 另有（非本仓库内） | 后端 HTTPS 入口 |
| GitHub 账号 | 已有（`Jack-Kunlun`） | 代码托管 + Actions 采集 + Pages |
| 微信小程序（已备案） | 已有 | 第二载体 |

---

## 二、总体架构

```
        ┌──────────────────────────── 境外 ────────────────────────────┐
        │                                                              │
   x.com/thsottiaux ──► GitHub Actions（每 30 分钟）                    │
   （未登录 HTML，        ├─ node scripts/collect.mjs   采集 + 分类 + 识别信号
     内嵌 RSC 载荷）      ├─ node scripts/build.mjs     构建期预渲染
                         └─ node scripts/sync.mjs      推送数据到境内
        │                            │
        │                            ├──────────────► git commit data/ + dist/
        │                            │                        │
        │                            │                        ▼
        │                            │                 GitHub Pages
        │                            │                 （主站，PRD 已确认）
        │                            │
        └────────────────────────────┼────────────────────────────┐
                                     │ POST /api/ingest           │
        ┌──────────────────────────── 境内 ─────────────▼───────────┴────┐
        │                                                              │
        │  境内服务器（已备案域名 + HTTPS，反向代理 Caddy）              │
        │    ├─ POST /api/ingest    接收境外采集结果（token 鉴权）       │
        │    ├─ data/*.json         运行时唯一数据源                     │
        │    ├─ node scripts/build.mjs   数据更新后重建 dist/（境内镜像） │
        │    ├─ GET /api/*          小程序调用的接口                     │
        │    └─ GET /               境内镜像站（分享用链接）              │
        │                                                              │
        └──────────────────────────────────────────────────────────────┘
                                     ▲
                                     │ HTTPS
                              微信小程序（已备案）
```

**这张图里最关键的一条线**：Actions 采集一次，产出物经**两条通道分发**（git → Pages；POST → 境内），
两边用的是**同一份采集产物 + 同一份模型代码**。A3 验收（页面数字与 API 数字一致）由此成立，
不靠人工比对维持。

---

## 三、逐项选型

| 维度 | 结论 | 一句话理由 |
|---|---|---|
| 运行时 | **Node.js 24 LTS** | Node 20 已 EOL；22 也已降为 Maintenance，24 是唯一的 Active LTS |
| 后端框架 | **`node:http` + 手写路由**（不引 Express/NestJS） | 8 个 GET 端点，框架带来的抽象成本大于收益 |
| 运行时依赖 | **0 个** | 部署即拷源码，无 `npm install` 失败点、无供应链面 |
| 构建期依赖 | **允许**（仅 OG 图生成引入 1 个） | 构建在 CI 里跑，失败可见且不污染线上 |
| 数据存储 | **JSON 文件 + 原子写** | 53 条记录 / 一年跨度，数据库是负资产 |
| 采集执行环境 | **GitHub Actions** | runner 在境外（解 C1），免服务器、免运维 |
| 数据分发 | **git（备份+Pages源） + POST 推送（境内）** | 境外出、境内入，境内服务器无需访问境外 |
| 网页托管 | **GitHub Pages（主） + 境内镜像（分享用）** | 见 3.5 —— 这是本文最需要你看的一段 |
| 小程序后端 | **境内自制服务 + 反向代理 + Let's Encrypt** | 解 C2 |
| 反向代理 | **Caddy** | 自动申请与续期证书，配置文件只有 5 行 |
| 进程守护 | **systemd** | 与「零依赖」一致，不用 pm2 |
| 分享卡片图 | **构建期 SVG → PNG**（`@resvg/resvg-js`） | 复用已有的图表 SVG 生成能力 |
| 订阅消息 | **小程序一次性订阅 + 服务端 push** | 长期订阅对工具类目不开放，见第六节 |
| 监控告警 | **`/api/health` + GitHub Actions 内置失败通知** | 本阶段不自建外部通道，见 3.8 |

### 3.1 运行时：Node 20 → 24 LTS

`Dockerfile` 用 `node:20-alpine`，workflow 用 `node-version: '20'`。
**Node 20 已于 2026-04-30 结束维护**（EOL），不再收任何更新。当前是 2026-09，
继续用它等于把一个已停止维护的运行时挂在公网入口上。

**结论：升级到 Node 24 LTS（Krypton）。** 依据是 Node.js Release Working Group 的官方日程：

| 版本 | 当前状态 | Active LTS 起 | Maintenance 起 | EOL |
|---|---|---|---|---|
| 20.x Iron | EOL | 2023-10-24 | 2024-10-22 | **2026-04-30** |
| 22.x Jod | **Maintenance LTS** | 2024-10-29 | 2025-10-21 | 2027-04-30 |
| **24.x Krypton** | **Active LTS** | 2025-10-28 | 2026-10-20 | 2028-04-30 |
| 26.x | Current | 2026-10-28 | 2027-10-20 | 2029-04-30 |

三点判断依据：

1. **Node 24 是当前唯一的 Active LTS。** 生产应用应当只用 Active LTS 或 Maintenance LTS，
   而 24 是这两者里更新的那一条。
2. **Node 22 已经在 2025-10 降为 Maintenance**，只收关键修复与安全补丁，不再有新特性。
   选它拿到的是「还剩 7 个月安全支持且已停止演进」的支线。
3. **26 不用**：它要到 2026-10-28 才转 LTS，现在还在 Current 阶段，新项目不应压在一个
   尚未转 LTS 的版本上。

代码本身没有用到任何版本特性，这次升级是**改两行配置**，无代码改动。

### 3.2 后端框架：继续不引框架

现有实现是 `node:http` + 一张 `ROUTES` 表。要新增的端点只有 `/api/ingest`（POST）与订阅相关 2 个，
总量不超过 12 个。

否决的选项：

| 选项 | 否决理由 |
|---|---|
| Express | 唯一的收益是路由语法糖；代价是首次出现 `node_modules`，破坏「拷源码即部署」 |
| NestJS / Fastify | 一个 8 端点的只读 API，引入 DI 容器与装饰器不划算 |
| Serverless（云函数） | 采集要跑 30 分钟一轮的定时任务，且要跨轮次读写数据；Serverless 的冷启动与状态管理反而更贵 |

### 3.3 数据存储：继续用 JSON 文件

数据规模：**53 条重置记录 + 近百条推文 + 1 份信号结果**，一年增长 50 条量级。

现有实现已经解决了 JSON 存储唯一的真问题 —— **并发写**：
`saveJson()` 先写临时文件再 `rename()`，读取方永远看不到半截 JSON。

否决的选项与理由：

| 选项 | 否决理由 |
|---|---|
| PostgreSQL / MySQL | 为 53 行数据运维一个数据库实例，是纯粹的负担 |
| SQLite（`node:sqlite`） | 技术上可零依赖（Node 24 内置），但**当前数据量下不解决任何问题**。留作订阅用户量上来后的选项 |
| 云数据库 | 增加成本与网络依赖，与 C3 冲突 |

**唯一需要重新评估的触发条件**：F9 订阅用户数超过约 1 万。届时 JSON 全量读写会变成瓶颈，
再切换到 SQLite 或云数据库 —— 数据访问已经收敛在 `server/store.mjs` 一个文件里，迁移成本可控。

### 3.4 数据分发：境外出、境内入

这是全篇最麻烦的一环，因为 C1 与 C2 把「采集」和「服务」硬性分到了两个网络域。

**结论：数据**只**在境外采集一次，然后朝两个方向分发，境内服务器不主动访问境外。**

```
Actions 采集完成
   ├─ 通道 1：git commit data/ + dist/  →  GitHub Pages 部署
   └─ 通道 2：POST https://<已备案域名>/api/ingest  →  境内服务器落盘
```

**为什么不让境内服务器定时 `git pull`**：
境内访问 `github.com` 虽然实测可达，但 `git pull` 依赖的是长期稳定的 HTTPS 链路，
一旦抖动就会出现「页面是新的、API 是旧的」这种最难排查的静默不一致。
而「境外主动 POST 到境内」这个方向 —— 境内服务器的公网入口本来就对全球开放，
GitHub runner 访问它没有任何网络障碍。**把不可靠的方向换成可靠的方向，比加重试更有效。**

**失败与幂等**：

| 情况 | 处理 |
|---|---|
| POST 失败 | Actions 内重试 3 次（指数退避）；仍失败则记录，下一轮采集会覆盖 |
| 境内服务重启中 | 同上，下一轮补齐。数据本身带 `generatedAt`，下一轮是全量覆盖而非增量追加 |
| 推送乱序（旧数据后到） | 服务端只接受 `generatedAt` 比当前更新的载荷，旧的直接丢弃并返回 `stale` |

**接口契约**：

```
POST /api/ingest
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json
{
  "generatedAt": "2026-09-21T01:30:00.000Z",   // 采集时刻，同日幂等判据
  "resets": { "records": [...] },               // data/resets.json 全文
  "tweets": { "tweets": [...], "updated_at": "..." },
  "stats":  { "stats": {...}, "generated_at": "...", "errors": [...] }
}
→ 200 { "ok": true, "accepted": true, "records": 53 }
→ 200 { "ok": true, "accepted": false, "reason": "stale" }
→ 401 { "error": "unauthorized" }
```

`INGEST_TOKEN` 与 `ADMIN_TOKEN` **用两个不同的值**：前者只允许写数据，
后者允许触发采集 —— 采集在境内会失败（C1），没有理由让一个只写数据的凭证拥有触发采集的权限。

### 3.5 网页托管：GitHub Pages 为主，境内镜像兜底

**已确认：主站放 GitHub Pages。** 这个选择的好处很实在 —— 免费、免备案、部署链路最短
（Actions 构建完直接发布，不需要管服务器）。技术选型层面它没有问题。

但有一件事必须说清楚，因为它直接关系到 G3（分享物料）这个目标能不能达成：

> **GitHub Pages 在中国境内的可达性是不稳定的。**它不是「慢」，是「时好时坏」——
> 取决于当前 DNS 解析结果与链路状态，且用户侧无法自行修复。
> 对一个把「给国内同行和招聘方看」当核心目标的站点，这意味着**一部分分享链接点开会是空白页**。

这不是否决 GitHub Pages 的理由（它作为作品集入口完全合格），而是**它不该是唯一的入口**。
所以架构里加了一条近乎零成本的兜底：

| 入口 | 地址 | 用途 | 成本 |
|---|---|---|---|
| 主站 | GitHub Pages | 作品集入口、被搜索引擎收录、给海外看 | 0 |
| 镜像 | `<已备案域名>/` | **对外分享时用这个链接** | 0（服务器已在跑，多托管一个静态文件） |

镜像站怎么来：境内服务器收到 `/api/ingest` 后，直接调用 `node scripts/build.mjs` 重建 `dist/`
——构建脚本零依赖，本来就在仓库里，不需要额外同步通道。

**分享时的规则写死**：对外发的链接用境内域名。GitHub Pages 的地址放在简历和 GitHub 主页。

### 3.6 反向代理：Caddy

```caddyfile
tibo.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

就这 5 行。Caddy 自动申请并续期 Let's Encrypt 证书，而 nginx 需要额外维护 certbot 定时任务 ——
对一个单人维护的项目，少一个会过期失败的东西比多 1% 的性能重要。

后端保持监听 `127.0.0.1`，不直接暴露公网，由 Caddy 终结 TLS。

### 3.7 进程守护：systemd

```ini
[Unit]
Description=Tibo Reset Observatory
After=network.target

[Service]
WorkingDirectory=/srv/tibo-reset
ExecStart=/usr/bin/node server/index.mjs
EnvironmentFile=/srv/tibo-reset/.env
Restart=always
RestartSec=5
User=tibo

[Install]
WantedBy=multi-user.target
```

不用 pm2：它是个需要 `npm install` 的依赖，而 systemd 是操作系统自带的。
`Restart=always` 已经覆盖了本项目需要的全部守护能力。

**关键配置**：境内机器的 `.env` 里必须设 `COLLECT_INTERVAL_MIN=0` —— 关掉内置调度器。
在境内跑采集必然超时（C1），开着它只会每 30 分钟产生一条无意义的错误记录，
把真正的错误淹没掉。

### 3.8 告警：本阶段不建外部通道

**结论：本次不配置任何外部告警通道**（飞书 / 企业微信 / 邮件服务 / 短信），
不新增 webhook、不新增 Secret、不新增接收端。

**为什么这个决定是安全的** —— 采集链路本身已经是「失败可见」的，不依赖推送：

| 机制 | 谁提供 | 是否需额外配置 |
|---|---|---|
| workflow 运行失败邮件 | GitHub Actions 内置，失败时自动通知仓库关注者 | 无需 |
| `/api/health` 端点 | 本项目后端，返回服务状态与数据新鲜度 | 无需 |
| 页面上的数据更新时间 | 产物本身，陈旧立刻看得出来 | 无需 |

在这三条之上再叠一层推送，边际价值主要是「知道得早一点」，
而代价是引入一个要长期维护的凭证与接收端。**本阶段不付这个代价。**

**若后续要接**（例如采集连续多轮失败、服务长时间不可达），
接收端用「只有自己一人的飞书群 + 自定义机器人 webhook」，
由 Actions 直接 POST —— 这是零权限门槛、且不依赖任何本机常驻进程的路径。
届时只需新增一个 Secret，架构其余部分不动。

**范围边界**：外部告警通道不在 M3 开发范围内。
`/api/health` 端点保留，它是服务自检能力，与告警通道无关。

---

## 四、A3 一致性怎么保证（页面数字 = API 数字）

A3 是 PRD 里最容易悄悄失效的一条。两个数字来源不同、更新节奏不同，靠人工比对迟早失守。

**机制**：

1. **同一份输入**：两边的 `data/*.json` 都来自同一次 Actions 采集，且推送是**全量覆盖**。
2. **同一份代码**：`predictAll()` / `detectSignals()` / `buildChartData()` 是同一批模块，
   两条路径都调用它们，不存在「页面版模型」与「API 版模型」。
3. **可校验的时间戳**：
   - 页面顶部标注数据更新时刻（取自 `stats.generated_at`）
   - `/api/state` 返回 `dataUpdatedAt`（同一个字段）
   - 两者相等即一致；不等说明某条通道迟了，这是**可观测**的，不是不可见的
4. **采集时刻固定**：`generated_at` 在采集完成时写一次，两条通道共享同一个值。

**验收做法（已落地）**：`scripts/check-consistency.mjs`，已进 CI（`collect.yml` 的
「校验页面与 API 一致」步骤）。页面是**构建期静态渲染**（锚定 `stats.generated_at`），
API 是**请求时实算**（锚定 `asOf`），所以不能拿两个数字硬比 —— 拆成四条精确判据：

| # | 判据 |
|---|---|
| 1 | 页面上抓到的数字 == 用 `builtAt` 重算的结果 |
| 2 | 页面内嵌 digest 里的数字确实出现在页面可见文字中（防「算对了但没渲进去」） |
| 3 | API 返回 == 用 `asOf` 重算的结果 |
| 4 | 两边按各自显示精度取整后相等 |

**一个不能拿来比对的字段**：`prediction.uncertainty` 来自 bootstrap 重采样，而
`bootstrapCI()` 用 `Math.random` —— 同一个请求连跑两次结果都不一样。
把它放进比对清单，这条验收就变成随机的了。

---

## 五、F8 分享卡片实现

**目标**：链接发到微信 / X / 微博时，能展开出标题、描述与预览图。

**技术路径**：构建期生成 `og-image.png`（1200×630），并把绝对 URL 写进 `<meta>`。

```
data/*.json
   └─► scripts/og-image.mjs
         ├─ 复用 src/lib/scene.js 的图元（生存曲线缩略）
         ├─ 叠加核心数字（中位间隔、当前已过天数）
         └─ 出 SVG ─► @resvg/resvg-js ─► dist/og-image.png
```

选择这条路径的理由：

| 方案 | 判断 |
|---|---|
| **SVG → PNG（选定）** | 图表本来就是 SVG，`scene.js` 的图元可直接复用，是增量最小的一条路 |
| 手工做固定模板图 | 数字写不进去，或要额外写一套叠字逻辑，且容易与页面内容漂移 |
| Canvas 服务端截图（Puppeteer） | 为了每月一张图引入一个浏览器运行时，代价与收益完全不成比例 |

**对 D-002「零运行时依赖」的处理**：这条底线指的是**运行时**。`@resvg/resvg-js` 只在
**构建阶段**使用，不进 `server/`，线上依然一个 `node_modules` 都没有。
`Dockerfile` 因此改成**两阶段**：构建阶段 `npm ci` + 装 CJK 字体 + 出 `dist/`（含 OG 图），
运行阶段只拷 `dist/` / `server/` / `src/` / `data/` / `package.json`。

⚠ 这一条差点漏掉，记下来：F8 上线后，原来的单阶段 `Dockerfile` 里
`RUN node scripts/build.mjs` 会直接 `ERR_MODULE_NOT_FOUND` —— `og-image.mjs` 对 resvg 是
**静态 import**，而镜像里按「零依赖」的假设没有 `node_modules`，于是构建整个失败。
另外 `node:24-alpine` 不带中文字体，即便补上依赖也会静默出一张汉字全是空方框的卡片，
所以构建阶段改用 debian 系基础镜像并显式装 `fonts-noto-cjk`。

**移动端卡片尺寸**：微信与 X 的预览图在信息流里会被裁切，核心数字必须放在**中间安全区**
（1200×630 的中心 1000×500 内），不能贴边。`scripts/og-image.mjs` 把这条契约导出为
`OG_LAYOUT`，由 `scripts/test-og.mjs` 断言，不靠肉眼。

### 5.1 落地（M3）

实现落在 `scripts/og-image.mjs`，由 `scripts/build.mjs` 在构建末尾调用，产出 `dist/og-image.png`。
元信息由 `scripts/render.mjs` 的 `renderOgMeta()` 注入，补齐 6 条：
`og:title` / `og:description` / `og:image` / `og:image:width` / `og:image:height` /
`twitter:card`，以及 `og:url`。

**两个静默陷阱**（都已在代码里挡住，这里记下原因）：

| 陷阱 | 表现 | 对策 |
|---|---|---|
| **字体** | resvg 找不到 CJK 字体时**不报错**，只是把每个汉字画成一个空方框 —— 静默产出一张坏卡片 | 出图前探测系统字体，找不到就**拒绝出图**（`buildOgImage` 返回 `null`，`build.mjs` 打警告）；CI 侧再装 `fonts-noto-cjk`（带 `continue-on-error`，装不上不至于搞挂整条采集） |
| **字号** | 图内文字用的是**绝对字号**（宽版 11px），按 1000px 宽直接出图，缩到缩略图只剩 4–5px | 改为**按 760px 宽渲染，再 `scale()` 放大到 1000** —— 字号随缩放一起放大，缩略图里仍可读 |

**分享域名的注入方式**：`og:url` / `og:image` 必须是绝对地址，域名由构建期环境变量
`SITE_URL` 注入。**不配则这两条 meta 不输出**（`twitter:card` 同时退化为 `summary`）——
宁可少两条 meta，也不输出一个平台抓不到的相对地址，那样只会得到一个没有图卡的分享。
对外分享用境内镜像域名（见 3.5），GitHub Pages 作为作品集入口。

---

## 六、F9 订阅消息实现（含一个必须先知道的限制）

### 6.1 现实约束

微信小程序的订阅消息分两类：

| 类型 | 授权方式 | 可推送条数 | 本项目的可用性 |
|---|---|---|---|
| **一次性订阅** | 用户每次点击授权 | **1 条 / 次授权** | ✅ 可用 |
| 长期订阅 | 一次授权长期有效 | 不限 | ❌ 仅对特定类目开放（政务、医疗、交通等），**工具类目拿不到** |

**这意味着 F9 只能做成「用户授权一次，下次重置时推送一条」**，推完额度归零，
要再收到通知得重新进入小程序授权。

这个限制不建议绕过（比如诱导用户连续授权多次），它属于微信明确禁止的行为。
**F9 的产品定位因此应该是「重要事件提醒」而不是「订阅推送」** —— 让用户自己决定
哪一次重置值得占用他的一次授权额度。

这个限制要写进小程序的交互文案里，不能让用户以为「订阅了就永久通知」。

### 6.2 技术设计

```
小程序端
  ├─ 用户点「下次重置时提醒我」→ wx.login 拿 code → wx.requestSubscribeMessage
  ├─ 授权成功 → POST /api/subscribe { code, templateId }
  └─ 服务端用 code 换 openid，落盘 subscriptions.json（原子写，与现有存储一致）

境内服务器
  ├─ 收到 /api/ingest → 先落盘并立即返回 200，再异步做通知（推送失败不该让 CI 变红）
  ├─ 检测「是否出现新的重置事件」
  │    判据：resets.records 里出现 announced_at 晚于「水位线」的新条目
  ├─ 命中 → 遍历 subscriptions.json
  ├─ 取 access_token（缓存，提前 5 分钟刷新；有效期 7200 秒）
  ├─ 调用 subscribeMessage.send（逐个，带限流）
  └─ 成功 或 永久失败 → 移除该条订阅（一次性额度已消耗 / 已不可用）
```

**必须处理的点**：

| 点 | 处理 |
|---|---|
| `access_token` 刷新 | 服务内存缓存 + 提前 5 分钟刷新；**刷新失败不清空旧 token**，避免雪崩式失败 |
| 两处刷新冲突 | 单实例部署，无并发问题；若将来多实例，需外部存储 —— 当前不设计 |
| `AppSecret` 保管 | 只存服务器 `.env`，**绝不进 git**；`.gitignore` 需确认覆盖 |
| 推送限流 | 逐个发送，间隔 50ms；失败重试 1 次后放弃并记录 |
| 推送时机 | **只在确认的新重置事件上触发**，不在「预测可能重置」时触发 —— 否则就是误报，直接违反 PRD 的 0 误报要求 |
| openid 存储 | `subscriptions.json`，量级小，与现有存储方式一致 |

**接口契约**：

```
POST /api/subscribe
{ "code": "<wx.login 换来的 code>", "templateId": "..." }
→ 200 { "ok": true }

POST /api/unsubscribe
{ "openid": "..." }   // 由服务端从 code 换取，不信任客户端传入的 openid
→ 200 { "ok": true }
```

`openid` **必须由服务端用 `code` 调微信接口换取**，不能接受客户端直接传 openid ——
否则任何人都能伪造别人的 openid 去订阅或退订。

### 6.3 落地（M3）

实现分两处：`server/wechat.mjs`（微信侧：token / code 换 openid / 发消息）、
`server/subscribe.mjs`（订阅名单持久化 + 「有没有新重置」的判定）。
测试在 `scripts/test-subscribe.mjs`（53 项）与 `scripts/test-miniprogram.mjs`（82 项，含小程序端订阅链路）。

几处不显然但必须这么写的决定：

| 决定 | 原因 |
|---|---|
| 水位线 `last_event_at` **只升不降** | 同一次重置被反复推送是这类功能最常见的翻车方式。落盘异常或时钟回拨时，宁可漏推一次，也不重复打扰用户 |
| **首次运行只建基线，不群发历史事件** | 新部署的服务第一次 ingest 时，历史里所有重置都「没推过」。不建基线就会一次性给所有人推一堆旧事件 |
| **永久失败码删订阅，瞬时失败保留** | `43101`（用户拒收）/ `40003`（openid 无效）重试多少次都不会成功，留着只是每次白跑一遍；而网络抖动、频率限制这类瞬时失败如果删掉，就是把用户烧掉的那次授权额度白白浪费 |
| **`access_token` 刷新失败不清空旧 token** | 清空会让所有推送在刷新窗口内集体失败，雪崩式放大 |
| 授权文案显式写出**一次授权只对应一次通知** | 这是类目限制导致的真实行为，不能让用户以为「订阅了就长期通知」（见 6.1） |

`subscriptions.json` 含 openid，属个人信息，**已进 `.gitignore`** ——
CI 会 `git add data`，不显式排除就会被推进公开仓库。

环境变量：`WX_APPID` / `WX_SECRET` / `WX_TEMPLATE_ID` / `WX_SUBSCRIBE_PAGE` / `WX_TEMPLATE_DATA`。
前三个不配齐则 F9 整体静默关闭，并在启动日志里说明原因（不静默失败）。

---

## 七、部署清单

### 7.1 前置（一次性）

| # | 事项 | 说明 |
|---|---|---|
| 1 | 仓库设为 **public** | 见 8.1 —— 这直接决定 Actions 额度够不够 |
| 2 | 提交 `data/` 与 `dist/` | 采集产物要进仓库才能被 Pages 使用；不加这两项，整条链路不成立 |
| 3 | 补 `.dockerignore` | 现在没有，`COPY . .` 会把 `node_modules` 与 `.git` 一起拷进镜像 |
| 4 | 增 `Dockerfile` 的 Node 版本 | `node:20-alpine` → `node:24-alpine` |
| 5 | workflow 的 `node-version` | `'20'` → `'24'` |
| 6 | 补 Pages 部署 workflow | 现在 `collect.yml` 只提交代码，没有 Pages 发布步骤 |
| 7 | 初始化 git 仓库 | ✅ 已执行 —— `main` 分支，远端 `Jack-Kunlun/tibo-reset`。**remote 必须走个人 SSH 别名**，原因见附注第 9 条 |

### 7.2 境内服务器

```bash
# 1. 代码
git clone <repo> /srv/tibo-reset && cd /srv/tibo-reset

# 2. 配置（AppSecret 等只存在这里）
cat > .env <<'EOF'
PORT=8787
COLLECT_INTERVAL_MIN=0      # 境内必须关闭内置采集（C1）
ADMIN_TOKEN=<随机值>
INGEST_TOKEN=<另一个随机值>
SOURCE_ACCOUNT=thsottiaux
WX_APPID=<小程序 AppID>
WX_SECRET=<小程序 AppSecret>
EOF
chmod 600 .env

# 3. 守护
cp deploy/tibo-reset.service /etc/systemd/system/ && systemctl enable --now tibo-reset

# 4. 反代
cp deploy/Caddyfile /etc/caddy/Caddyfile && systemctl reload caddy
```

### 7.3 GitHub Actions 侧配置

| 类型 | 名称 | 用途 |
|---|---|---|
| Secret | `INGEST_URL` | `https://<已备案域名>/api/ingest` |
| Secret | `INGEST_TOKEN` | 与服务器 `.env` 一致 |
| Variable | `SITE_URL` | 对外分享用的域名（境内镜像），写进 `og:url` / `og:image`。**不配则不输出这两条 meta，A10 不成立** |

> 本次只配这两个 Secret 加一个 Variable。外部告警通道不在范围内（见 3.8），无告警相关凭证。


### 7.4 小程序侧

| # | 事项 |
|---|---|
| 1 | 微信后台配置 `request` 合法域名 = 已备案域名（**未配之前所有请求走 fail 回调，静默失败不弹错**） |
| 2 | `miniprogram/config.js`：`apiBase` 改为实际域名、`enabled: true` |
| 3 | 申请订阅消息模板（重置发生时通知），把模板 ID 填进 `config.js` 的 `subscribeTemplateId` |
| 4 | 确认小程序类目 —— 影响能否使用长期订阅（预期是不能） |

第 3 步填之前 `subscribeTemplateId` 保持空字符串，页面上不会出现提醒入口（功能整体关闭）。
服务和构建两侧的完整环境变量清单见 `README.md` 的「环境变量」。

---

## 八、成本

### 8.1 Actions 额度（这一项必须算清）

| 仓库可见性 | 免费额度 | 本项目消耗 | 结论 |
|---|---|---|---|
| **public** | **不限量** | — | ✅ 用 public |
| private | 2000 分钟/月 | 48 轮/天 × 约 1 分钟 ≈ **1440 分钟/月** | ⚠️ 占 72%，再叠加其他 workflow 会超 |

**结论：仓库设为 public。** 这个项目的数据本来就全部来自公开推文，产物也是公开页面，
不存在需要私有化的内容。私有的唯一后果是把 Action 额度卡在 72% 的位置上。

### 8.2 现金成本

| 项 | 成本 |
|---|---|
| 境内服务器 | 已有，**0 新增** |
| 域名 | 已有备案域名，**0 新增** |
| GitHub Actions | public 仓库，**0** |
| GitHub Pages | **0** |
| Let's Encrypt 证书 | **0** |
| **合计** | **0 元** |

### 8.3 维护成本

| 项 | 频率 | 说明 |
|---|---|---|
| X 页面结构变更导致采集失效 | 不可预期 | 最大的单点。X 改版就要改 `parseTweets()`；已设计的降级是保留旧数据 + 错误可见 |
| 证书续期 | 自动 | Caddy 负责 |
| 服务器安全更新 | 季度 | 系统层面 |
| Actions schedule 延迟 | 常态 | 高峰期可能延迟数分钟；见 9.3 |

---

## 九、风险

### 9.1 采集解析失效（最高）

**风险**：`parseTweets()` 依赖 x.com 未登录页面里的 RSC 载荷结构与 `full_text` / `created_at_ms`
字段名。X 改版即失效。

**影响**：不是「数据错误」而是「数据停更」—— 页面继续显示最后一次成功的数据。

**缓解**：现有降级语义已正确处理（保留旧数据、错误进 `stats.json`、经 `/api/health` 暴露）。
本阶段不发外部告警（见 3.8），发现路径是 Actions 失败邮件 + 页面上的数据更新时间。
**「停更」不会自己恢复**，这是它的真实风险 —— 所以数据更新时间必须显著展示，
让停滞在页面上一眼可见，而不是藏在角落。

### 9.2 GitHub Pages 国内不可达（C4 的直接威胁）

**已由架构缓解**：境内镜像站作为分享入口（3.5）。GitHub Pages 不可达时，
受影响的是「作品集入口」而不是「引流入口」。

### 9.3 Actions 定时任务不准时

GitHub 的 `schedule` 事件在高峰期会延迟，且**仓库连续 60 天无提交时会被自动停用**。

**缓解**：
- 延迟：不影响正确性。页面明确标注「数据更新于 X」，延迟可见。
- 60 天停用：本项目每轮采集都会产生提交，天然规避。

### 9.4 品类寿命（PRD R1）

机制正从「无条件重置」转向发券（53 条里已有 3 条发券型）。本现象随时可能结束。

**已由架构缓解**：`SOURCE_ACCOUNT` 是环境变量，换一个账号即可观测别的对象。
数据口径、模型、双端渲染都不绑定具体账号 —— 这是 F10 的成本能压到「改一个配置」的原因。

### 9.5 订阅消息的类目限制（F9）

**风险**：长期订阅对工具类目不开放，F9 只能做一次性订阅（6.1）。

**影响**：F9 的实际价值低于「订阅推送」这个说法给人的预期。

**处理**：不绕限制。把 F9 定位为「重要事件提醒」，并在小程序文案里写清
「一次授权对应一次通知」。这条要在 M3 做 F9 时落到 UI 文案上，否则用户会预期落空。

---

## 十、对里程碑的影响

| 阶段 | 本次选型带来的具体工作 | 状态 |
|---|---|---|
| M3 定稿开发 | F8 OG 图生成脚本 + meta 补齐；F9 订阅链路（含 openid 换取）；`/api/ingest` 端点；Node 版本升到 24；`.dockerignore`；`collect.yml` 补 Pages 发布与 ingest 推送 | ✅ 已完成 |
| M3 验收 | A3 一致性比对脚本进 CI；A10 分享展开实测 | ⏳ A3 已进 CI 并通过；A10 的「微信内实分享」待人工做一次 |
| M4 上线 | 境内服务器部署（systemd + Caddy）；Actions Secrets 与 Variables 配置；小程序域名白名单与模板申请 | 待启动 |

**选型不改变 PRD 的功能范围**，只决定这些功能用什么实现。

---

## 附：本次选型修正的既有问题

| # | 问题 | 位置 | 处理 |
|---|---|---|---|
| 1 | Node 20 已 EOL（2026-04-30） | `Dockerfile`、`collect.yml` | 升级到 24 LTS（22 亦已降为 Maintenance） |
| 2 | `COPY . .` 无 `.dockerignore`，会把 `node_modules`、`.git` 拷进镜像 | `Dockerfile` | 补 `.dockerignore` |
| 3 | `collect.yml` 只提交代码，没有 Pages 发布步骤 | `.github/workflows/` | 补部署 workflow |
| 4 | 文档提到的 `miniprogram/utils/paint.js` 不存在 | `docs/decisions.md` D-007 | 已改为实际的 `draw.js` |
| 5 | 项目未 `git init` | 仓库根 | 已完成：初始化于 2026-09-21，`main` 分支，远端 `git@github.com-personal:Jack-Kunlun/tibo-reset.git` |
| 6 | F8 之后单阶段 `Dockerfile` **构不出来**：`og-image.mjs` 对 resvg 是静态 import，而镜像里没有 `node_modules`，`RUN node scripts/build.mjs` 直接 `ERR_MODULE_NOT_FOUND` | `Dockerfile` | 改两阶段构建（构建阶段 `npm ci` + 装 CJK 字体，运行阶段零依赖） |
| 7 | `node:24-alpine` 无中文字体，OG 图会静默出成汉字空方框 | `Dockerfile` | 构建阶段换 debian 系基础镜像并装 `fonts-noto-cjk` |
| 8 | `.dockerignore` 排除了 `package-lock.json`，与「必须提交 lock 文件」的约定冲突，`npm ci` 会失败 | `.dockerignore` | 移出排除列表 |
| 9 | 本机 `~/.ssh/config` 是**双账号**结构：`github.com` 默认走公司 key（`sbt-zhengyunfeng`），个人号只能走别名 `github.com-personal`。而 git 全局身份也是公司号 —— 直接用 `git@github.com:Jack-Kunlun/...` 会以公司身份访问个人仓库（被拒），commit 作者栏还会写进公司邮箱，在公开仓库里永久可见 | `~/.ssh/config`、仓库 local config | remote 固定用 `git@github.com-personal:...`；仓库 local 身份设 `Jack-Kunlun <47732460+Jack-Kunlun@users.noreply.github.com>` —— 用 noreply 邮箱既能让 GitHub 正确归因，又不把真实邮箱写进公开历史 |
