# 技术选型

> M2 交付物。输入是 `PRD.md`（需求基线，已确认）与 `decisions.md`（已有决策记录）。
> 本文给出**确定结论**，并记录被否掉的选项与理由 —— 便于将来有人问「为什么不用 X」。

---

## 一、选型的输入

### 1.1 硬约束（不可协商）

| # | 约束 | 来源 | 影响 |
|---|---|---|---|
| C1 | `x.com` 的 Cloudflare 拦的是**机房 IP 段**，不是「境外 IP」（实测同一时刻：runner 403 挑战页 / 本机住宅出口 200 完整页面） | 实测 | 采集必须从**非机房出口**发起（现由本机承担）；服务自身跑在机房，故服务不采集 |
| C2 | 小程序的 `request` 合法域名**必须已 ICP 备案**且走 HTTPS | 微信侧硬要求 | 小程序后端必须在境内、有备案域名 |
| C3 | 定位是**作品 + 引流**，不是商业产品 | PRD 1.1 | 成本趋零优先于性能与扩展性 |
| C4 | 受众在国内（同行 / 招聘方 / 内容创作者） | PRD 二 | 分享链接的**国内可达性**是效果前提 |
| C5 | 事件驱动型工具，用户平均 8 天才想起一次 | PRD 二 | 不投入留存类基础设施；分享物料的价值高于日活 |

### 1.2 已确认的资源

| 资源 | 状态 | 用途 |
|---|---|---|
| 境内服务器 | 已有 | 小程序后端 + **网页主站**（同源托管） |
| 已备案域名 | 已有：`reset.example.com` | 后端 HTTPS 入口，也是网页主站入口 |
| GitHub 账号 | 已有（`<你的 GitHub 用户名>`） | 代码托管 + 代码变更时构建 + Pages（异地备份） |
| 微信小程序（已备案） | 已有 | 第二载体 |

---

## 二、总体架构

```
   x.com/thsottiaux ──► 本机（住宅出口）· WorkBuddy 定时任务   ← 采集只在这里发生
   （登录态 HTML，        └─ node scripts/collect.mjs   CDP 驱动已登录 Chrome，增量收割
     CDP 驱动 Chrome，              build.mjs           构建兜底页 dist/ + OG 卡 + 小程序快照
     收 / 与 /with_replies）        push-ingest.mjs     ① 直推后端 → 线上立即生效
                                    git push            ② 提交留档（有实质变化才提交）
        │
        │ ① POST /api/ingest
        ▼
   境内 · 已备案域名 https://reset.example.com · Nginx 终结 TLS
     tibo-reset 容器（docker run --restart always）
       ├─ POST /api/ingest   接收本机推送（Bearer token 鉴权）
       ├─ data/*.json        运行时唯一数据源
       ├─ GET /              **请求时**用当前数据实时渲染整页（不是构建产物）
       ├─ GET /api/*         小程序调用的接口
       └─ dist/              渲染失败时的兜底页 + OG 分享图（构建期产物）
        ▲
        │ HTTPS
   微信小程序（已备案）

        └── ② git push（只有**代码**变更才触发构建）
              GitHub Actions ──► GitHub Pages（异地备份入口，不是主入口）
```

**这张图里最关键的一条线**：采集只发生一次（本机），产出的数据**同时**走两路 ——
`POST /api/ingest` 直推后端（线上立即生效，**不经构建**），git 提交留档。
页面由后端在**请求时**用当前数据实时渲染，所以「数据变了」与「页面变了」之间没有任何中间环节。
两路用的是**同一份采集产物 + 同一份模型代码**，A3 验收（页面数字与 API 数字一致）由此成立，
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
| 采集执行环境 | **本机（住宅出口）· 定时任务** | 只有非机房出口能过 Cloudflare（解 C1）；CI 采不到 |
| 数据分发 | **本机 POST 直推（境内） + git（留档）** | 数据一到即生效，不经构建；境内服务器不访问境外 |
| 网页托管 | **后端容器同源托管（主） + GitHub Pages（异地备份）** | 见 3.5 —— 主入口在境内，分享链接不再看 Pages 的脸色 |
| 小程序后端 | **境内自制服务 + 反向代理 + 域名 DV 证书** | 解 C2 |
| 反向代理 | **Nginx**（复用服务器上已有的） | 主域站点已用它；子域证书另签，见 `deploy.md` |
| 进程守护 | **`docker run --restart always`** | 镜像即部署单元，不用 systemd，也不用 pm2 |
| 分享卡片图 | **构建期 SVG → PNG**（`@resvg/resvg-js`） | 复用已有的图表 SVG 生成能力 |
| 订阅消息 | **小程序一次性订阅 + 服务端 push** | 长期订阅对工具类目不开放，见第六节 |
| 监控告警 | **`/api/health` + 页面自带的数据陈旧提示** | 本阶段不自建外部通道，见 3.8 |

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

### 3.4 数据分发：本机直推，境内被动接收

这是全篇最麻烦的一环，因为 C1 与 C2 把「采集的出口」与「服务的入口」分到了两种性质不同的网络。

**结论：数据只采集一次（本机），采完立刻 `POST` 给境内服务落盘；git 提交只做留档。**
境内服务器全程不主动访问境外。

```
本机（住宅出口）采集完成
   ├─ 主通道：POST https://reset.example.com/api/ingest → 境内落盘 → 页面刷新即新
   └─ 留档：  git commit data/ miniprogram/ → 仓库历史（不再是任何分发链路的中间站）
```

**为什么不让境内服务器定时 `git pull`**：
境内访问 `github.com` 虽然实测可达，但 `git pull` 依赖的是长期稳定的 HTTPS 链路，
一旦抖动就会出现「页面是新的、API 是旧的」这种最难排查的静默不一致。
而「本机主动 POST 到境内」这个方向 —— 境内服务器的公网入口本来就对全球开放，
阻力只在本机这一侧，而它本来就在跑采集。**把不可靠的方向换成可靠的方向，比加重试更有效。**

**为什么不再经 CI 中转**（2026-09-22，D-025）：
原先是 `git push` → CI 构建 → CI 转发 `POST`。这条链多出的两个环节现在都没有产出 ——
页面已改为请求时实时渲染、不再需要构建，「数据变化触发构建」这件事本身也就失去了意义。
绕一整圈还让数据链多一个能断的地方。**采完直推，链路最短。**

**失败与幂等**：

| 情况 | 处理 |
|---|---|
| POST 失败 | `push-ingest.mjs` **单次尝试，不重试**，当轮日志记一次失败。下次采集有实质变化时会重推（全量覆盖），不需要补数据 |
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

### 3.5 网页托管：后端同源托管为主，GitHub Pages 只做异地备份

**结论：主站在后端容器里同源托管，地址 `https://reset.example.com`。**
`GET /` 由 `server/index.mjs` 在请求时用当前数据实时渲染，与 `/api/*` 同一个进程、同一个域名。
GitHub Pages 保留，但定位降为**异地备份** —— 主域或服务器整体出事时，还有个能打开的副本。

为什么把主备反过来（2026-09-22，D-025）：原方案是「Pages 为主 + 境内镜像兜底」，
但它要求**人工守住**「对外发的链接一律用境内域名」这条纪律 —— 一旦哪次顺手发了 Pages
地址，就暴露在可达性风险里。主站直接放境内，等于把这条纪律变成默认值。

> **GitHub Pages 在中国境内的可达性不稳定**，这不是「慢」，是「时好时坏」，
> 取决于当时 DNS 解析与链路状态，用户侧无法自行修复。
> 对一个把「给国内同行和招聘方看」当核心目标的站点，这正是主站不能放在它的原因。

> ⚠ 已知代价，写在最显眼处：**OG 分享图是图片文件，只能构建期生成**。
> 它不会随数据变 —— 分享卡片上的数字停在**最后一次构建**（容器那份 = 最后一次 `ship-image.sh`，
> Pages 那份 = 最后一次 CI 构建），而不是最后一次采集。
> 页面本身是实时的，**只有链接预览这张图是旧的**。

| 入口 | 地址 | 用途 |
|---|---|---|
| 主站 | `https://reset.example.com` | 对外分享、小程序接口、日常访问 |
| 备份 | GitHub Pages | 主站不可用时的副本；被搜索引擎收录、给海外看 |

主站这一路：容器内 `GET /` 实时渲染；渲染失败退回 `dist/index.html`（宁可数据旧，也不白屏）。
Pages 由 GitHub Actions 在**代码变更时**构建，与数据无关 —— 它不再是数据链路上的一站。

### 3.6 反向代理：Nginx（复用服务器上已有的）

```nginx
server {
    listen 443 ssl;
    server_name reset.example.com;
    ssl_certificate     /etc/nginx/ssl/reset.example.com/bundle.crt;
    ssl_certificate_key /etc/nginx/ssl/reset.example.com/privkey.key;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

这台服务器上**已经在跑 Nginx**（主域 `example.com` 的站点在用），加一个 `server` 块即可，
不另起一套反代。完整步骤见 [`deploy.md`](./deploy.md) 第三节。

**TLS 终止这一层绕不过去**：`server/index.mjs` 用 `node:http`，不做 TLS，而小程序强制要求
https —— 所以「Nginx + 证书」是必需品，不是可选项。证书已单独申请（腾讯云 TrustAsia DV，
只覆盖本子域），**有效期 90 天且无自动续期**，续期靠人工替换 —— 见 `deploy.md` 3.2。

后端监听 `127.0.0.1:8787`，不直接暴露公网，由 Nginx 终结 TLS。

### 3.7 进程守护：`docker run --restart always`

```bash
docker run -d --restart always --name tibo-reset \
  -p 127.0.0.1:8787:8787 \
  -v /srv/tibo-data:/app/data \
  --env-file /srv/tibo.env \
  tibo-reset:amd64
```

`tibo-reset:amd64` 里的 `:amd64` 是**架构后缀**，不是版本号 —— 本机是 arm64、服务器是
x86_64，两种架构的镜像会共存于同一台机器，名字带后缀才不会拿错。运行时变量
（`SITE_URL`、`INGEST_TOKEN`、以及将来的 `WX_*`）统一放 `/srv/tibo.env`，用 `--env-file`
注入，重建容器时不必重新生成口令。

不用 systemd，也不用 pm2：**镜像本身就是部署单元**。`--restart always` 覆盖了本项目需要的
全部守护能力（崩溃重启、开机自启），而 systemd 还得额外维护一个 unit 文件、并对 Node 路径
做假设 —— 那份 unit 文件已随本次调整删除（D-025）。

`server/entrypoint.sh` 会在数据卷为空时把镜像内的种子数据拷进去，所以上面这条命令**可以直接跑**，
不需要预先手工初始化数据目录。

**关键配置**：镜像里 `COLLECT_INTERVAL_MIN` 的默认值已经是 `0`（关掉内置调度器）。
境内机器走的是云机房出口，跑采集必被 Cloudflare 挑战（C1）—— 开着它只会每轮产生一条
无意义的错误记录，把真正的错误淹没掉。**别改这个默认值。**

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

1. **同一份输入**：两边的 `data/*.json` 都来自同一次采集（本机），且推送是**全量覆盖**。
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
元信息由 `src/lib/render.mjs` 的 `renderOgMeta()` 注入，补齐 6 条：
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
对外分享用的就是主站域名 `https://reset.example.com`（见 3.5），GitHub Pages 退为异地备份。

⚠ **分享图的陈旧性**：`og:image` 是构建期产物，数据变了它不会跟着变 ——
分享卡片上的数字停在最后一次构建。这是「OG 图只能构建期出」的固有结果，见 3.5。

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
| 2 | 提交 `data/`（**不提交 `dist/`**）| `data/` 是产品本体，进仓库留档，同时是镜像的种子数据；`dist/` 是构建产物，CI 与镜像各自构建，见 `.gitignore` |
| 3 | 补 `.dockerignore` | 现在没有，`COPY . .` 会把 `node_modules` 与 `.git` 一起拷进镜像 |
| 4 | 增 `Dockerfile` 的 Node 版本 | `node:20-alpine` → `node:24-alpine` |
| 5 | workflow 的 `node-version` | `'20'` → `'24'` |
| 6 | 补 Pages 部署 workflow | ✅ 已执行 —— `collect.yml` 在**代码变更时**构建并发布 Pages（异地备份）；数据更新不再触发它 |
| 7 | 初始化 git 仓库 | ✅ 已执行 —— `main` 分支，远端 `<你的 GitHub 用户名>/tibo-reset`。**remote 必须走个人 SSH 别名**，原因见附注第 9 条 |

### 7.2 境内服务器

完整步骤见 [`deploy.md`](./deploy.md)。三条要点：

- **不用 systemd、不用 Caddy**：`docker run --restart always` 就是守护，反代复用服务器上
  已有的 Nginx（主域站点在用它）。数据卷单独挂一个目录，重建容器不丢数据。
- **TLS 终止这一层绕不过去**：`server/index.mjs` 用 `node:http`，不做 TLS，而小程序强制
  要求 https。所以 Nginx 的 server 块 + 证书必须有（证书已申请好，人工上传，见 `deploy.md` 3.2）。
- 采集**不在这台机器上跑**（机房出口必被 Cloudflare 挑战），由本机采集后 POST 到
  `/api/ingest`。所以这里**不配** `COLLECT_INTERVAL_MIN` —— 镜像默认已是 `0`。

部署形态是**一个镜像文件**，服务器上只有 docker（不要 git、不要 node、不要 npm）：

```bash
# ① 【本机】构建 + 导出 + 传过去。默认 --platform linux/amd64 —— 本机 arm64、
#    服务器 x86_64，这是最容易踩死的一步（架构错了的报错只有 exec format error，不提架构）
scripts/ship-image.sh root@<服务器 IP>

# ② 【服务器】核对 → 装进 docker → 起
cd /srv
sha256sum -c tibo-reset-amd64.tar.gz.sha256
gunzip -c tibo-reset-amd64.tar.gz | docker load
mkdir -p /srv/tibo-data        # 数据目录独立于容器与镜像：容器要写它，重建不碰它
cat > /srv/tibo.env <<EOF
SITE_URL=https://reset.example.com
INGEST_TOKEN=$(openssl rand -hex 24)
EOF
chmod 600 /srv/tibo.env
docker run -d --restart always --name tibo-reset \
  -p 127.0.0.1:8787:8787 \
  -v /srv/tibo-data:/app/data \
  --env-file /srv/tibo.env \
  tibo-reset:amd64
# 然后按 deploy.md 第三节加 Nginx server 块并上传证书
```

`INGEST_TOKEN` 要记进 `deploy.md` 第四节那份本机的 `~/.tibo-ingest.env`，两边必须一致。
F9 的 `WX_APPID` / `WX_SECRET` 同理写进 `/srv/tibo.env`；不配则 F9 整体关闭并在启动日志里
说明原因（不静默失败）。

### 7.3 GitHub Actions 侧配置

| 类型 | 名称 | 用途 |
|---|---|---|
| Variable | `SITE_URL` | `https://reset.example.com`，写进 `og:url` / `og:image`。**不配则不输出这两条 meta，A10 不成立** |

⚠ `INGEST_URL` / `INGEST_TOKEN` 两个 Secret **不再需要**（2026-09-22，D-025）：数据改由
**本机直推**后端（`scripts/push-ingest.mjs`，凭据在 `~/.tibo-ingest.env`）。原先是 CI 构建后
转发，不仅多绕一圈，还与「数据不触发构建」直接冲突 —— 那一步一删，数据链才真的只剩本机一条。

> 外部告警通道不在范围内（见 3.8），无告警相关凭证。


### 7.4 小程序侧

| # | 事项 |
|---|---|
| 1 | 微信后台配置 `request` 合法域名 = 已备案域名（**未配之前所有请求走 fail 回调，静默失败不弹错**） |
| 2 | `miniprogram/config.js`：`apiBase` = `https://reset.example.com`、`enabled: true` ✅ 已改 |
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
| private | 2000 分钟/月 | CI 只在**代码变更时**触发（数据更新不再触发），一次构建约 1 分钟 → 每月通常不到 100 分钟 | 额度早已不是瓶颈 |

**结论：仓库设为 public。** 这个项目的数据本来就全部来自公开推文，产物也是公开页面，
不存在需要私有化的内容。

> ⚠ 这一节的旧结论建立在一个已经不存在的假设上：原先数据每 30 分钟提交一次、每次都触发 CI 构建，
> 私有仓库会吃掉 1440 分钟/月（72%）。2026-09-22 起数据更新不再触发构建（D-025），
> 那个额度顾虑随之消失。此节保留是因为「public」这个结论仍然成立，
> 但**理由已经变了** —— 不再是配额所迫，只是没有任何需要私有的内容。

### 8.2 现金成本

| 项 | 成本 |
|---|---|
| 境内服务器 | 已有，**0 新增** |
| 域名 | 已有备案域名，**0 新增** |
| GitHub Actions | public 仓库，**0** |
| GitHub Pages | **0** |
| 域名证书（腾讯云 DV） | **0** |
| **合计** | **0 元** |

### 8.3 维护成本

| 项 | 频率 | 说明 |
|---|---|---|
| X 页面结构变更导致采集失效 | 不可预期 | 最大的单点。X 改版就要改 `parseTweets()`；已设计的降级是保留旧数据 + 错误可见 |
| 域名证书续期 | **每 90 天，人工** | 腾讯云 DV 免费证书，**没有 certbot 那套自动续期**。到期前在控制台重签、下载、按 `deploy.md` 3.2 替换。忘了就会 https 失效（小程序直接白屏） |
| 服务器安全更新 | 季度 | 系统层面 |
| 本机（跑采集那台机器）关机 / 休眠 | 不可预期 | **采集的单一入口**。停掉就停更，CI 帮不上忙（机房 IP 采不到）；见 9.3 |

---

## 九、风险

### 9.1 采集解析失效（最高）

**风险**：`parseTweets()` 依赖 x.com 未登录页面里的 RSC 载荷结构与 `full_text` / `created_at_ms`
字段名。X 改版即失效。

**影响**：不是「数据错误」而是「数据停更」—— 页面继续显示最后一次成功的数据。

**缓解**：现有降级语义已正确处理（保留旧数据、错误进 `stats.json`、经 `/api/health` 暴露）。
本阶段不发外部告警（见 3.8），发现路径是页面上的数据更新时间与「数据未更新」提示。
**「停更」不会自己恢复**，这是它的真实风险 —— 所以数据更新时间必须显著展示，
让停滞在页面上一眼可见，而不是藏在角落。

### 9.2 GitHub Pages 国内不可达（C4 的直接威胁）

**已从根本上绕开**：主站现在就在境内（见 3.5），对外分享的链接不经过 GitHub Pages。
Pages 退为异地备份 —— 它不可达时，受影响的是「备份入口」，而不是「引流入口」。

### 9.3 本机是采集的单一入口

**风险**：采集只有本机这一条路径。那台机器关机、休眠，或自动化任务停掉，数据就停更 ——
而 CI 帮不上忙，它采不到（机房 IP 必被 Cloudflare 403）。

**缓解**：
- 页面自己会说：超过两个采集周期没有**成功**更新就显示「数据未更新」，停滞一眼可见
  （判据是「当前时间 − `tweets.json` 的 `updated_at`」，见 `data-source.md` §5）。
  这是**有意的**取向 —— 宁可显示陈旧，也不假装新鲜。
- 但**它不会自己恢复**：页面只能报警，补数据仍需人工把那台机器唤醒。这是该机器在本架构里的
  真实权重，写在这里以免被忘记 —— 别让「只是个定时任务」的印象掩盖了它是采集的唯一入口。
- 早期还有一条 CI 每 30 分钟的定时器充当「兜底采集」，2026-09-22 移除（`decisions.md` D-023）：
  它的净产出只有「重新部署一次 Pages」，因为 CI 根本采不到数据；它唯一的价值（发现本机停摆）
  已由页面判据接手，而且更及时 —— 页面一被打开就在算，不依赖任何进程在跑。

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
| M4 上线 | 境内服务器部署（`docker run` + Nginx 反代 + 子域证书）；CI 侧仅需 `SITE_URL` Variable；小程序域名白名单与模板申请 | 待启动 |

**选型不改变 PRD 的功能范围**，只决定这些功能用什么实现。

---

## 附：本次选型修正的既有问题

| # | 问题 | 位置 | 处理 |
|---|---|---|---|
| 1 | Node 20 已 EOL（2026-04-30） | `Dockerfile`、`collect.yml` | 升级到 24 LTS（22 亦已降为 Maintenance） |
| 2 | `COPY . .` 无 `.dockerignore`，会把 `node_modules`、`.git` 拷进镜像 | `Dockerfile` | 补 `.dockerignore` |
| 3 | `collect.yml` 只提交代码，没有 Pages 发布步骤 | `.github/workflows/` | 补部署 workflow |
| 4 | 文档提到的 `miniprogram/utils/paint.js` 不存在 | `docs/decisions.md` D-007 | 已改为实际的 `draw.js` |
| 5 | 项目未 `git init` | 仓库根 | 已完成：初始化于 2026-09-21，`main` 分支，远端 `git@github.com-personal:<你的 GitHub 用户名>/tibo-reset.git` |
| 6 | F8 之后单阶段 `Dockerfile` **构不出来**：`og-image.mjs` 对 resvg 是静态 import，而镜像里没有 `node_modules`，`RUN node scripts/build.mjs` 直接 `ERR_MODULE_NOT_FOUND` | `Dockerfile` | 改两阶段构建（构建阶段 `npm ci` + 装 CJK 字体，运行阶段零依赖） |
| 7 | `node:24-alpine` 无中文字体，OG 图会静默出成汉字空方框 | `Dockerfile` | 构建阶段换 debian 系基础镜像并装 `fonts-noto-cjk` |
| 8 | `.dockerignore` 排除了 `package-lock.json`，与「必须提交 lock 文件」的约定冲突，`npm ci` 会失败 | `.dockerignore` | 移出排除列表 |
| 9 | 本机 `~/.ssh/config` 是**双账号**结构：`github.com` 默认走公司 key（`<你的公司账号>`），个人号只能走别名 `github.com-personal`。而 git 全局身份也是公司号 —— 直接用 `git@github.com:<你的 GitHub 用户名>/...` 会以公司身份访问个人仓库（被拒），commit 作者栏还会写进公司邮箱，在公开仓库里永久可见 | `~/.ssh/config`、仓库 local config | remote 固定用 `git@github.com-personal:...`；仓库 local 身份设 `<你的 GitHub 用户名> <<你的 GitHub id>+<你的 GitHub 用户名>@users.noreply.github.com>` —— 用 noreply 邮箱既能让 GitHub 正确归因，又不把真实邮箱写进公开历史 |
