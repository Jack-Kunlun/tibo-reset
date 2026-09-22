# 数据源

本文件回答一个问题：**数据从哪里来，为什么这么设计。**
如果你只想知道「采集挂了怎么办」，直接看最后一节。

---

## 1. 结论速览

| 项 | 结论 |
|---|---|
| 主链路 | **本机登录态浏览器**（CDP 驱动已登录的 Chrome），滚动收割完整时间线 |
| 兜底 1 | 免登录 HTML 首屏（本机没开 Chrome 时），**只覆盖最近 7 条** |
| 兜底 2 | **CI 采集**，仅在数据陈旧时尝试；runner 是机房 IP，必被 Cloudflare 挑战（403） |
| 采集范围 | **上一次明确重置往前 24 小时 → 现在**（见 §4.1） |
| 他的回复 | 时间线不含回复、搜索不可用 → 靠**回复雷达**从别人推文的详情页里捞（抽样，非穷举） |
| 403 的性质 | **不是「X 封了境外 IP」，是 Cloudflare 拦云机房 IP 段** |
| 页面异常横幅 | 由数据新鲜度决定，不再由「某一次采集尝试的成败」决定 |
| 采集频率 | 本机决定（建议 1 小时一次），CI 每 30 分钟兜底一次 |

---

## 2. 403 的根因（实测，不是推测）

同一时刻、同一 URL，两个出口的结果**完全不同**：

| 出口 | 结果 |
|---|---|
| 本机（住宅 IP，经 `HTTPS_PROXY`） | **HTTP 200**，213,770 字节完整页面，**4/4 稳定**，约 1.4 秒 |
| GitHub Actions（AWS 机房 IP） | **HTTP 403**，5,749 字节的 Cloudflare 挑战页 |

本地那份页面里 `full_text:"…"` 与 `created_at_ms:` 都在，7 条推文一应俱全 ——
也就是说**解析逻辑从来没问题，问题只在出口 IP 的声誉**。

这个结论推翻了两条早期假设：

- ❌ 「x.com 在境内不可直连」→ 真实情况是本机走代理可直连，早期那次 3/3 超时是 curl 没走代理导致的
- ❌ 「换域名可以绕过」→ 见下节

---

## 3. 已排除的通道（别再试了）

以下全部在 runner 上实测过，不是猜的。省得下次再走一遍。

### 换域名 —— 无效

`x.com` / `twitter.com` / `mobile.twitter.com` **三个域名的 CF 策略完全一致**，
返回的是同一份 5749 字节挑战页。加完整浏览器头（`sec-ch-ua`、`sec-fetch-*`、
`upgrade-insecure-requests`）与裸 UA 的结果也一样。

### X 官方嵌入接口 —— 被限流

`syndication.twitter.com/srv/timeline-profile/screen-name/<user>` 返回 **429**（20 字节），
连试 3 次带退避重试仍是 429。这个接口本身是免 key 的，但机房 IP 被限流。

### X API —— 通，但缺 queryId

`POST api.x.com/1.1/guest/activate.json` → **200**，能拿到 guest_token；
`api.x.com/graphql/<queryId>/UserByScreenName` → **200**，能拿到 userId。

**但**：内置的 web bearer 已失效 —— 首轮实测（11:56）它还能换到 token，
几分钟后同样的 bearer 就返回
`{"errors":[{"message":"Invalid or expired token","code":89}]}`。
而 `UserTweets` 的 queryId 需要从 X 前端 JS 里现挖，拿 JS 又需要站点 HTML（403），
成了闭环。这条链路**理论上可达但当前不可用**。

### archive.org —— 可达但没用

`archive.org/wayback/available` → 200，x.com 有快照。
但快照 HTML 只有 **3,521 字节**，里面**没有任何 JS 引用**，
挖不出 bearer 与 queryId。作为「绕开 CF 拿页面源码」的入口是失败的。

### 第三方镜像 —— 全废

| 通道 | 结果 |
|---|---|
| `rsshub.app/twitter/user/<user>` | 404（账号不可见） |
| `nitter.net` / `xcancel.com` / `lightbrd.com` / `nitter.space` | 451 / 403 / 超时 |
| `nitter.privacyredirect.com` / `nitter.tiekoetter.com` | 200 但返回的不是 RSS 条目 |
| `api.fxtwitter.com/<user>` | 200，但只有用户资料，**没有时间线接口** |
| `api.vxtwitter.com` | 403 Cloudflare 挑战 |
| `api.twitterapi.io` | 403（要 key） |

### 免费代理中转 —— 全废

`allorigins` / `codetabs` → 522；`r.jina.ai` → 403 CF；`corsproxy.io` → 401。

### 另一个坑：`codex-resets.com` 在 runner 上也是 403

历史回填用的 `https://codex-resets.com/api/v1/resets` 在**本机**返回 200，
在 **runner 上同样被 CF 挑战**。由于历史回填只在冷启动执行，这个失败此前从未暴露。

### `with_replies` 与 `search` —— 未登录态只返回空壳

想拿「他的回复」最自然的入口是 `x.com/<user>/with_replies`。未登录时它返回的是一张
826 行的「JavaScript is not available」错误页 —— 没有 RSC payload，一条推文都提不出来。

| 入口 | 字节 | `full_text` 出现次数 | 结论 |
|---|---|---|---|
| `x.com/<user>` 桌面 UA | 215,199 | **7** | ✅ 可用 |
| `x.com/<user>` 手机 UA | 215,731 | **7** | ✅ 同样可用（不是更少） |
| `x.com/<user>` Googlebot UA | 0 | 0 | ❌ 403 |
| `x.com/<user>/with_replies` | 298,643 | **0** | ❌ 空壳错误页 |
| `x.com/search?...` | 299,101 | **0** | ❌ 空壳错误页 |

> ⚠ 别用 `grep -c 'full_text:'` 数这个 —— 它数的是**行数**，而这类 HTML 常整个写在一行，
> 会给出「1 条」这种假数字。用 `(html.match(/full_text:/g) ?? []).length`。

**结论：未登录态下 profile 首屏是唯一能拿到推文列表的入口，而它只给最近 7 条原创**
（实测 Tibo 那 7 条跨 3.45 天，Udi 那 7 条跨 3.03 天）。回复不进这个流，搜索不可用。

### 推文详情页 —— 可读，但只给部分回复

`x.com/<account>/status/<id>` 未登录可读，且**带回复列表**。这是唯一能拿到回复的入口。
边界有两个：

- 只渲染**部分**回复。实测一条有 50 条回复的推文，页面上只有 3 条。
- 需要先知道推文 id（只有首屏或雷达候选里有）。

payload 里配对作者靠的是**物理顺序**：一条推文的作者 `screen_name` 出现在它的
`full_text` **之前**（实测距离 1.9k–3.7k 字符），所以「前向最近的 `screen_name`」
就是该条正文的作者。解析在 `parseTweetDetail()`，契约由 `scripts/test-parse.mjs` 锁定。

---

## 4. 采集主链路：本机登录态浏览器

### 4.1 为什么必须登录

未登录的 profile 首屏只给 **7 条**原创。这不是「少一点」——2026-09-12 那次重置的
**5 条全部落在 7 条窗口之外**（含 "Reset all propagated"），观测台一次都没看见
它本该盯住的那件事。7 条是 X 的权限设计，不是换请求头能解的问题（已穷举验证，见 §3）。

改走登录态后，同一时间点的抓取对比：

| 口径 | 覆盖到 09-12 当天的重置帖 | 09-11 以来条数 |
|---|---|---|
| 未登录首屏 | ❌ 0 条 | 7 |
| 登录态时间线 | ✅ 全部 5 条 | 16 |

**采集下界 = `resets.json` 里最近一条 `type: "reset"` 往前推 24 小时。**
（实现在 `src/lib/collect.mjs` 的 `resetFloorMs()`。）

为什么不硬切在重置那一刻：重置当天的前序预告常早于最终确认推文。09-12 那组就是
—— 03:20 的「Hi Astra users. A reset and a quick update…」在前，08:09 的
「Reset all propagated」在后，相隔 5 小时。硬切在 08:09 会把 03:20 那条切掉，
而它恰恰是本轮最该被看见的一条。

### 4.2 怎么跑起来

走 Chrome DevTools Protocol（`src/lib/browser.mjs`）：不需要 Apple Events、
不需要任何系统授权、不读 cookie 文件。

```bash
# 一次性：起一个独立 profile 的 Chrome，在里面登录 x.com
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/.tibo-reset-chrome" --no-sandbox \
  --proxy-server="127.0.0.1:7890" \
  --remote-debugging-port=9222 --remote-allow-origins='*' \
  "https://x.com/login"
```

之后 `node scripts/collect.mjs` 会自己接上去：端口已在监听就**复用**（不打扰你开着的
窗口），否则用同一个 profile 起一个 headless 实例，采完自己退出。
登录态留在那个 profile 目录里（**在 `$HOME` 下，绝不进仓库**）。

四个踩过的坑：

| 坑 | 现象 | 处理 |
|---|---|---|
| headless 的 UA | x.com 稳定返回 **403**（正文 53B） | 加 `--user-agent=<真实 Chrome UA>`。**别把 403 归因到代理出口 IP** |
| 默认 profile | 远程调试被禁用（Chrome ≥136 起） | 必须用独立 `--user-data-dir` |
| 跳屏滚动 | **静默丢条目**：同一窗口跳屏拿到 12 条，小步拿到 16 条 | 小步滚动（一屏的 85%），不能用 `scrollTo(0, scrollHeight)` |
| host sandbox | Chrome 自身沙箱初始化失败 | 加 `--no-sandbox` |

### 4.3 免登录 HTML 的已知缺陷：不能用来判断推文归属

这条降级路径把 RSC payload 里出现过的 `full_text` 全部收下，而 payload 里**混着
别人的推文**。实测有两条被记成 Tibo 的，实际分属 `@sama` 与 `@j_dekoninck`
（把原始 URL 打开，X 会直接跳到对方主页）。

浏览器路径没有这个问题：只收 `article` 里带 `/thsottiaux/status/<id>` 的条目。
所以 `data/tweets.json` 里 `foundVia: "timeline"` 的行属于**低可信度历史数据**，
`foundVia: "timeline-browser"` 才是可归因的。

---

## 5. 采集的分工与触发

```
本机（住宅出口）
  node scripts/collect.mjs        # CDP 驱动已登录的 Chrome，滚动收割完整时间线
  node scripts/build.mjs          # 构建页面与小程序数据
  git add data miniprogram/utils/scene.js && git commit && git push
        │
        ▼
GitHub Actions（机房出口）
  push 触发 → 跳过采集 → 构建页面 → 提交（无变化则跳过）→ 发布 Pages → 推送境内服务
```

CI 上不尝试浏览器路径（没有 Chrome、也没有登录 profile），走免登录 HTML 兜底；
那条路径在机房 IP 上本来就会被 Cloudflare 挑战，所以 CI 的作用只是「数据陈旧时
再试一次，试成功了更好，失败了页面照常发布并挂出异常提示」。

### 回复雷达

回复不进首屏、搜索又不可用，所以**「他回复了谁」这件事没法从他的账号直接查到**。
能拿到的只有反方向：在别人推文的详情页里，会出现他的回复。

于是采集多了一条链路：盯住一批「他会去回复的人」（`RADAR_ACCOUNTS`，默认
`udiWertheimer`），抓他们首屏推文 → 抓这些推文的详情页 → 在回复列表里找他。

```bash
node scripts/collect.mjs                       # 默认带雷达
node scripts/collect.mjs --no-radar            # 关掉
node scripts/collect.mjs --radar-accounts=a,b  # 换对象池
node scripts/collect.mjs --radar-limit=6       # 每轮每个账号最多开几次详情页
```

三个设计决定值得记下来：

- **候选按线索「排序」，不是「过滤」**。这条有实证依据：2026-09-21 那条预告，
  他回复的原推文是「你们这周没发布什么有意思的东西」—— 额度词出现在同一串推文的
  下一段里纯属运气。如果那条只写这一句，过滤式闸门会把它整条丢掉，
  回复里的承诺也跟着丢。所以未命中的推文照进候选，只是排在后面（`rankRadarCandidates`）。
- **命中时连同被回复的原推文一起入库**（字段 `inReplyTo`）。识别算法要用它 ——
  他那条回复自己一个额度词都没有（见下）。
- **对象池可以从 `data/radar.json` 的 `targets` 扩展**：历次命中过的被回复者，
  是经证实会引来他回复的账号。

**它是抽样，不是穷举**：详情页只给部分回复，所以「没命中」**不能**推出「他没回复过」。
X 会把高影响力账号的回复往上顶，这是它能工作的前提，不是保证。

### 「新鲜度短路」

采集入口支持 `--max-age=<分钟>`：数据比这个时限还新时，**连请求都不发**。

```bash
node scripts/collect.mjs --max-age=120   # CI 兜底用
node scripts/collect.mjs                 # 本机用，总是采
```

为什么需要它：CI 兜底采集注定失败，若照采不误，它会把 `errors` 写进
`stats.json`，页面上刚被本机清干净的「数据采集异常」横幅又会被贴回来 ——
**明明数据是新鲜的，却告警说采不到**。有了短路，CI 只在数据确实陈旧时才尝试，
那种失败才是真该告警的情况。

短路时**不写任何文件**。否则 `stats.json` 的 `generated_at`（采集运行时刻）每轮都变，
CI 会为它单独提交，于是每 30 分钟污染一条提交历史，而数据一个字都没动。

### CI 提交什么

`data/` 与 `miniprogram/utils/scene.js`。**刻意不含 `miniprogram/data/snapshot.js`** ——
它是构建产物，内嵌了构建时刻（`generatedAt` / `now` 及其派生的全部预测值），
每次构建都不同，提交它等于把「48 条提交/天」换个来源。它由本机构建后提交。

---

## 6. 日常怎么用

### 本机采集（正常情况）

前提：本机有一个已登录 x.com 的 Chrome profile（`$HOME/.tibo-reset-chrome`，
登录一次即可，见 §4.2）。

```bash
npm run collect        # 采集
npm run build          # 构建
git add data miniprogram && git commit -m "chore(data): ..." && git push
```

采集结束会打印**覆盖范围**：

```
--- 覆盖范围 ---
  来源      ✓ 登录态浏览器（完整时间线）
  采集下界  2026-09-11T08:09:17.000Z（上一次重置 - 缓冲）
  库内推文  16 条
```

看到「⚠ 免登录首屏（降级，只有最近 7 条）」就要当回事：数据确实写进去了，
但覆盖不到上一次重置 —— 那等同于回到了「漏掉 09-12 那次重置」的状态。
`data/tweets.json` 里的 `source` / `degraded` 字段会一起记下这件事。

推送后 CI 会自动建页面并发布，不需要额外操作。

### 怀疑采集坏了

```bash
node scripts/probe-sources.mjs     # 通道体检：六个候选组一次探完
```

它会给出每条通道的状态码、是否含推文正文、失败原因分布。
**必须用 `gh workflow run probe-sources.yml` 在 runner 上跑才有意义** ——
本机与 runner 的失败模式完全不同（前者超时、后者 403），
本机探针只能验证本机自己的出口。

### 页面挂着「数据采集异常」

说明数据确实陈旧（超过 `--max-age`）。依次查：

1. 本机能不能采：`node scripts/collect.mjs`，看报错
2. 出口是否正常：代理是否开着（`echo $HTTPS_PROXY` 应指向本地代理端口）
3. 若本机代理正常但 X 改了页面结构 → 参考 `scripts/test-parse.mjs`，
   它锁定了 payload 的结构契约，改动前后跑一遍就知道有没有破坏解析

---

## 7. 已知的未解项

- **CI 无法独立采集**。本机长期关机时，数据会停更，页面会挂出异常横幅。
  这是**有意的**：宁可显示陈旧，也不假装新鲜。
- **`resets.json` 不会自动发现新的额度重置**。历史回填只在冷启动执行，
  `classify()` 判定的推文类型目前没有消费方。核心数字「距上一次额度重置」
  依赖的是 `resets.json` 的历史记录，不是推文。
- **snapshot.js 的构建时刻内嵌问题只解决了「不提交」**，没有从根上让它稳定。
  根治需要把 `generatedAt` / `now` 改成取自数据时间戳，会改变小程序端的预测基准，
  所以留待单独确认。
- **回复雷达是抽样，不是穷举**。详情页只给部分回复（实测 3 条，而那条推文实际有 50 条），
  所以「扫了但没命中」不等于「他没回复过」。要提高覆盖只有两条路：加对象池、加频率。
- **雷达只能向前覆盖**。它靠「抓的时候推文还在首屏 7 条窗口内」才能拿到 id；
  一旦滑出（约 3 天），那条推文及其下的任何回复就再也拿不回来了。
  2026-09-21 那条预告（他回复 Udi）就是这样错过的 —— 它在雷达上线前就滑出了。
- **对象池目前是人工指定的**（默认只有 `udiWertheimer`）。自动扩展（把命中过的
  被回复者并进池子）已有数据基础（`radar.json` 的 `targets`），但尚未接进主流程。
