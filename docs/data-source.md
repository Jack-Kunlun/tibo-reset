# 数据源

本文件回答一个问题：**数据从哪里来，为什么这么设计。**
如果你只想知道「采集挂了怎么办」，直接看最后一节。

---

## 1. 结论速览

| 项 | 结论 |
|---|---|
| 主链路 | **本机采集**（住宅出口 IP），采完把 `data/` 推上来 |
| 兜底 | **CI 采集**，仅在数据陈旧时尝试；runner 是机房 IP，必被 Cloudflare 挑战（403） |
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

---

## 4. 因此：采集分两处

```
本机（住宅出口）
  node scripts/collect.mjs        # 采 x.com，成功
  node scripts/build.mjs          # 构建页面与小程序数据
  git add data miniprogram/utils/scene.js && git commit && git push
        │
        ▼
GitHub Actions（机房出口）
  push 触发 → 跳过采集 → 构建页面 → 提交（无变化则跳过）→ 发布 Pages → 推送境内服务
```

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

## 5. 日常怎么用

### 本机采集（正常情况）

```bash
npm run collect        # 采集
npm run build          # 构建
git add data miniprogram && git commit -m "chore(data): ..." && git push
```

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

## 6. 已知的未解项

- **CI 无法独立采集**。本机长期关机时，数据会停更，页面会挂出异常横幅。
  这是**有意的**：宁可显示陈旧，也不假装新鲜。
- **`resets.json` 不会自动发现新的额度重置**。历史回填只在冷启动执行，
  `classify()` 判定的推文类型目前没有消费方。核心数字「距上一次额度重置」
  依赖的是 `resets.json` 的历史记录，不是推文。
- **snapshot.js 的构建时刻内嵌问题只解决了「不提交」**，没有从根上让它稳定。
  根治需要把 `generatedAt` / `now` 改成取自数据时间戳，会改变小程序端的预测基准，
  所以留待单独确认。
