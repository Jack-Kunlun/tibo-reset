# 部署

后端服务是**唯一需要部署的东西**。它同时提供网页与 API，网页在请求时用当前数据实时
渲染，所以数据更新**不需要重新部署**（见 decisions.md D-025）。

不用 systemd，不用 docker-compose：`docker run --restart always` 就承担了守护职责，
一个容器一个卷。但有一层**绕不过去** —— `server/index.mjs` 用 `node:http`，**不做 TLS**，
而小程序强制要求 https。所以前面要有一个反向代理收 TLS。服务器上已有 Nginx
（主域 `example.com` 跑着另一个站点），复用它加一个 server 块即可。

```
浏览器 / 小程序
      │ https
      ▼
   Nginx（TLS 终止，复用现有那台）
      │ http，只绑 127.0.0.1
      ▼
   docker 容器 tibo-reset:8787
      │
      └─ /app/data ← 挂到宿主 /srv/tibo-data（数据落点，必须持久化）
```

---

## 一、前置（一次性）

| # | 事项 | 说明 |
|---|---|---|
| 1 | `reset.example.com` 的 DNS **A 记录** → 服务器 IP | 已就绪（2026-09-22 实测解析到 `203.0.113.10`） |
| 2 | 域名**已 ICP 备案** | 服务器在境内，未备案的域名 80/443 会被拦。主域 `example.com` 的 https 已可用，说明主域已备案；子域一般随主域覆盖，**但仍要在腾讯云控制台确认一次** |
| 3 | 服务器上已有 Nginx | 已就绪（1.31.4），且该子域的 80 端口已在做 301 跳 https |
| 4 | 服务器上有 docker | 不要 git、不要 node、不要 npm —— 镜像在本机构建好、走 scp 传过去（见第二节） |

✅ **证书已就绪**（2026-09-22）：现有主域证书的 SAN 只覆盖 `example.com` 与 `www`，
**不含本子域**，所以已单独申请一张，包在本机仓库根的 `reset.example.com_nginx/`
（**已加 `.gitignore` + `.dockerignore`，不会进仓库、不会进镜像**）。

| 项 | 实测值 |
|---|---|
| 主体 / SAN | `CN=reset.example.com`，SAN 只有这一个 |
| 签发者 | `TrustAsia DV TLS RSA CA 2024`（腾讯云签发的免费 DV，**不是** Let's Encrypt） |
| 有效期 | 2026-09-22 → **2026-12-21**（90 天） |
| 链 | `_bundle.crt` 含 3 张（叶子 + 中间 + 根），等价于 `fullchain.pem`，**直接用** |
| 私钥配对 | 已核验与证书公钥配对 |

⚠ **这是人工续期的证书，没有自动续期**。这与「用 certbot 签」是两种不同的运维方式，
续期动作必须有人记得做 —— 见 3.2。

---

## 二、拉起容器

部署物是**一个镜像文件**：网页、API、分享卡片图全都在里面，前端页面由后端进程在请求时
渲染（见 decisions.md D-025），所以**不存在「前端镜像 + 后端镜像」这种拆法**。

服务器上只需要 docker —— 不要 git、不要 node、不要 npm，也不需要在境内网络里去拉
Docker Hub。构建只发生在本机这一台机器上，整类失败都被挡在门外。

### 2.1 在【本机】出镜像文件

```bash
cd ~/projects/tibo-reset
scripts/ship-image.sh root@203.0.113.10     # 构建 + 导出 + scp，一次做完
```

不加地址就只在本机产出：`~/tibo-deploy/tibo-reset-amd64.tar.gz`（约 58 MB）与同名 `.sha256`。

⚠ **`SITE_URL` 必须能取到，脚本刻意不给默认值。** 它会被 `--build-arg` 烤进
`og:url` / `og:image` 与 **OG 分享图**。给个占位默认值的话，脚本会「构建成功、
但产出里印的是错域名」—— 这种失败比直接报错难发现得多（OG 图印旧数字那次就是这么来的）。

取值顺序：`--site` → 环境变量 `SITE_URL` → 本机凭据文件 `~/.tibo-ingest.env`。
三处都没有会当场报错退出。推荐写进凭据文件（与推送凭据同一份，真值只存一处）：

```bash
# 在【本机】执行，chmod 600，不进仓库
printf 'SITE_URL=https://你的域名\n' >> ~/.tibo-ingest.env
```

⚠ **架构必须匹配，这是最容易踩死的一步。** 本机是 Apple Silicon（arm64），
腾讯云 Ubuntu 64bit 的实例是 **x86_64**，所以脚本默认 `--platform linux/amd64`。
先确认一次更稳妥：

```bash
ssh root@203.0.113.10 uname -m    # x86_64 → 用默认；aarch64 → 加 --arch linux/arm64
```

架构不对的症状是容器起不来，日志里只有 `exec format error` ——
**那个报错里一个字都不提「架构」**，很容易往别处查。

### 2.2 在【服务器】load 并启动

```bash
# 1. 核对传输完整（上百兆的二进制走 scp 是可能悄悄截断的）
cd /srv
sha256sum -c tibo-reset-amd64.tar.gz.sha256

# 2. 装进 docker
gunzip -c tibo-reset-amd64.tar.gz | docker load

# 3. 凭据写成一个文件（一次生成，长期有效）
cat > /srv/tibo.env <<EOF
SITE_URL=https://reset.example.com
INGEST_TOKEN=$(openssl rand -hex 24)
EOF
chmod 600 /srv/tibo.env
cat /srv/tibo.env      # 记下 INGEST_TOKEN —— 本机推送要用同一个串（见第四节）

# 4. 数据目录（独立于容器，见下方「为什么分开」）
mkdir -p /srv/tibo-data

# 5. 启动（必须接进已有网关那张网络 —— 网关按容器名反代，见第三节）
docker run -d --restart unless-stopped \
  --name tibo-reset \
  --network edge_network \
  -p 127.0.0.1:8787:8787 \
  -v /srv/tibo-data:/app/data \
  --env-file /srv/tibo.env \
  --log-opt max-size=10m --log-opt max-file=3 \
  tibo-reset:amd64
```

> 末尾的 `:amd64` 是**架构后缀**，不是版本号。两种架构的镜像可以共存于同一台机器，
> 名字带后缀就不会搞混 —— `docker images` 里一眼看得出哪个是给服务器用的。

几个刻意的选择，都不是随手写的：

| 选择 | 原因 |
|---|---|
| `--network edge_network` | **必须**。网关容器在这张网里，配置里是 `proxy_pass http://tibo-reset:8787`（按**容器名**找，不走宿主端口）。不在同一张网里，`nginx -t` 会直接报 `host not found in upstream "tibo-reset"` |
| `--restart unless-stopped` | 沿用目标机现有约定（那台机器上其他容器都这么写）。语义上比 `always` 更合意：手工停掉的容器不该在重启后又自己起来 |
| `--log-opt max-size=10m --log-opt max-file=3` | 长期跑会被 json-file 日志慢慢撑爆盘（默认无上限） |
| `-p 127.0.0.1:8787:8787` | 只绑回环。公网入口只有 Nginx 的 443，容器端口不直接暴露 |
| `-v /srv/tibo-data:/app/data` | **必须**。`/app/data` 是唯一的数据落点，而镜像层是只读的 —— 不挂卷，容器一重启就退回镜像里那份初始快照 |
| 数据目录独立、名字与镜像无关 | 数据归数据、镜像归镜像：换镜像、重建容器都不碰它。也别放进任何 git 工作区（仓库里那份 `data/` 是**构建输入**，不是运行数据） |
| `--env-file` 而不是 `-e` 一串 | 值写一次、放在文件里，重建容器时不用重新 export，换个 shell 会话也不会丢 |
| `COLLECT_INTERVAL_MIN` 不传 | 镜像默认已是 `0`（关闭内置采集）。本镜像跑在机房出口，采集必被 Cloudflare 挑战 —— 采集在本机跑 |
| 不传 `WX_*` | 没配就是 F9 订阅整体关闭（启动日志会说明原因，不静默失败） |

**数据目录为空时不用担心**：`server/entrypoint.sh` 会在启动时发现 `/app/data` 为空，
把镜像内的种子数据拷进去。所以第 4 步的 `mkdir` 之后直接 run 就能得到一份可用数据，
不必手工初始化。（这一点实测过：bind mount 到空目录时 Docker **不会**自动填充 ——
那是 named volume 才有的行为 —— 所以要靠这个脚本兜住。上面那条 `docker run` 在本机
用 amd64 镜像实跑过一遍，启动日志确实打印「数据目录为空，用镜像内的种子数据初始化（5 个文件）」。）

### 2.3 本机拉不到 Docker Hub 时

**只影响「在本机出镜像」这一步，服务器完全不受影响**（服务器拿到的已经是文件）。

症状是 `docker build --platform linux/amd64` 失败：

```
failed to fetch oauth token: Post "https://auth.docker.io/token": Bad Gateway
```

原因不是「网络断了」，而是 **Docker Desktop 的 daemon 拉镜像不走 macOS 系统代理**：

| 路径 | 实测（2026-09-22） |
|---|---|
| 浏览器 / curl 直连 `auth.docker.io` | 超时（HTTP 000） |
| 同上经 `127.0.0.1:7890` | 200 |
| **daemon** 自己拉镜像 | 502 Bad Gateway（没走代理） |

`~/.docker/config.json` 里的 `proxies` 字段**管不到 daemon** —— 它只影响容器内的环境变量；
而 Docker Desktop 的代理开关存在受 macOS TCC 保护的配置文件里，脚本改不动。

所以要绕：**让容器去下载**（容器内的网络可以配代理，走的是 Docker VM 的出口）：

```bash
# 把 amd64 的 node:24-slim / node:24-alpine 搬进来（约 400 MB，走代理）
scripts/fetch-base-image.sh
```

它起一个临时容器跑 `skopeo`，dump 成 tar 再 `docker load` 回来，落到
`node:24-slim-amd64` 这样**带架构后缀**的名字上 —— 本机原有那份 arm64 保持不动
（不带 `--platform` 的本地构建还要用它）。之后 `ship-image.sh` 会自己检测到
本地 tag 架构不符、临时切过去、构建完再还原，不必手工干预。

搬一次长期有效。

**另一种解法**（一劳永逸，但要手动点几下）：Docker Desktop →
Settings → Resources → Proxies，勾 Manual、填 `http://127.0.0.1:7890`，Apply & restart。
之后 daemon 能自己拉镜像，本节就可以不管了。

---


## 三、Nginx 反代 + 证书

反代**不是自己起一个 nginx**，而是接进那台机器上已有的容器化网关
`edge-gateway`（`nginx:alpine`，独占 80/443，为 `example.com` 主域和
几个子域提供 TLS）。另起一个既会抢端口，也会多出两张证书、两套配置。

```
浏览器 / 小程序
      │ https
      ▼
edge-gateway（容器，0.0.0.0:80 + 0.0.0.0:443）
      │ http —— 在容器网络内按**容器名**解析，不走宿主端口
      ▼
tibo-reset:8787（同一个网络 edge_network）
```

### 3.1 往网关配置里追加 server 块

网关的配置是 `/opt/edge/current/docker/edge-nginx.conf`，bind mount 到容器内的
`/etc/nginx/conf.d/default.conf`。要追加的是下面这一段：

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name reset.example.com;

    ssl_certificate     /etc/nginx/certs/reset.example.com_bundle.crt;
    ssl_certificate_key /etc/nginx/certs/reset.example.com.key;
    add_header Strict-Transport-Security "max-age=31536000" always;

    # 本机自动化每轮采集后 POST /api/ingest，留够余量
    client_max_body_size 10m;

    location / {
        proxy_pass http://tibo-reset:8787;      # ← 容器名，不是 127.0.0.1
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

几处与「自己搭 nginx」不同的地方，都是有原因的：

| 写法 | 原因 |
|---|---|
| `proxy_pass http://tibo-reset:8787` | 用**容器名**，不用宿主端口 —— 两个容器在同一张网里，名字直连是最短路径，也不依赖 `-p` 映射 |
| 证书文件名是 `<域名>_bundle.crt` / `<域名>.key` | 沿用该网关已有的命名约定，续期时一眼能对上 |
| 没有单独的 80 块 | 子域的 80 由网关**已有的 80 块**统一 301 到 https，只需把 `reset.example.com` 并进那块的 `server_name`（见下） |
| 顶层 TLS 参数一个都没抄 | `ssl_protocols` / `ssl_ciphers` / session cache 定义在该文件**顶部**（http 上下文），server 块自动继承 |

还有一处**必须**一起做，否则这个子域的 http 请求会被主域的 80 块接走：

```nginx
# 该文件里已有的 80 块，把子域并进 server_name
server {
    listen 80;
    server_name example.com www.example.com reset.example.com;
    return 301 https://$host$request_uri;
}
```

> 实测确认过：只加 443 块、不并 80 块的 `server_name`，`http://reset.example.com`
> 不会 301 到 https。

⚠ **改这个文件必须原地写，绝不能 `mv`。** 它是 **bind mount 的单文件** —— 容器持有的是
**挂载那一刻的 inode**。`mv` 一个新文件上去会换掉 inode，容器里读到的仍是旧内容。
症状极难查：**配置改完、`nginx -t` 通过、`reload` 成功、宿主机上 `head` 看内容完全正确，
但线上一点变化都没有。** `cp -a` 或 Python 的 `open(path, 'w')` 都是原地写；
`mv` 和 `install` 都会换 inode，不能用在单文件挂载上。

交付包里的 `inject-nginx-conf.py` 做的就是这两件事（原地改 80 块的 `server_name`
+ 追加 443 块），幂等、可重复跑。改动前备份到 `/opt/edge/manual-backups/`，
`nginx -t` 不过就自动还原。

### 3.2 上传证书（人工续期，无自动续期）

证书包在**本机仓库根**的 `reset.example.com_nginx/`（该目录已被 git 与 docker
双双忽略 —— 私钥既不进版本库也不进镜像）。传到服务器，并沿用网关的命名约定：

```bash
# 在【本机】执行
scp reset.example.com_nginx/reset.example.com_bundle.crt ubuntu@203.0.113.10:~/
scp reset.example.com_nginx/reset.example.com.key        ubuntu@203.0.113.10:~/
```

```bash
# 在【服务器】执行 —— 证书目录归 root，要 sudo
cd ~
sudo install -m 644 reset.example.com_bundle.crt /opt/edge/certs/reset.example.com_bundle.crt
sudo install -m 600 reset.example.com.key        /opt/edge/certs/reset.example.com.key
rm -f reset.example.com_bundle.crt reset.example.com.key   # 私钥别留在容易被读到的地方
```

传 `~/` 而不是 `/srv/`：`/srv` 是 `root:root 755`，`ubuntu` 写不进去，`scp` 会报
`Permission denied` —— 那是**目录权限**问题，不是认证失败。

`install` 到 `/opt/edge/certs/` 是安全的：那里是**目录挂载**，新建/替换文件容器都看得到
（单文件挂载才有 3.1 说的 inode 问题）。

**为什么 `_bundle.crt` 可以直接用**：它已经含中间证书（实测 3 张），等价于 Let's Encrypt 的
`fullchain.pem`。**不要再拿它和别的链文件拼接** —— 拼了会重复下发中间证书。
`_bundle.pem` 与 `_bundle.crt` 实测逐字节相同，用哪个都行（本配置用 `.crt`）。

⚠ **这张证书不会自己续期。** 签发方是腾讯云（TrustAsia DV），**没有 certbot 那套定时器**：

| 事项 | 说明 |
|---|---|
| 到期日 | **2026-12-21**（90 天） |
| 怎么续 | 腾讯云控制台 → SSL 证书 → 对该域名重新申请（免费 DV 可续签），签发后重新下载 `_nginx` 包 |
| 续之后 | 重复上面这组 `scp` + `install` + `reload`。**Nginx 配置不用改**（路径没变，文件名也沿用同一套） |
| 不用做的 | **不用重启容器**。TLS 在 Nginx 这层终止，容器对此完全无感，页面与接口都不受影响 |

**怎么查还剩多久**（本机或服务器都能跑）：

```bash
echo | openssl s_client -connect reset.example.com:443 2>/dev/null \
  | openssl x509 -noout -subject -dates
```

### 3.3 让改动生效

**顺序不能反：先把应用容器起起来（第二节），再动网关配置。**
nginx 在**解析配置阶段**就会解析 `proxy_pass http://tibo-reset:8787`，容器还没接进
那张网时会直接报 `host not found in upstream "tibo-reset"` —— 看起来像语法错误，
实际是运行态依赖缺失。（这里栽过一次：脚本先注入配置、后起容器，跑到「校验并热加载」
就失败，白跑一趟。）

```bash
# 【服务器】先验，通过才热加载
docker exec edge-gateway nginx -t
docker exec edge-gateway nginx -s reload
```

**不要 `docker compose up -d` 重建网关** —— 那会中断主站和另外几个子域，而这里只需要
一次 reload。

⚠ **已知局限（已治）**：追加进去的配置位于软链 `current/` 之下，主站项目下次发布切换 release
时会一起消失（**只有这个子域受影响**，主站不受影响）。

**2026-09-25 这个局限真的兑现了一次**：12:04 主站切 release → 追加块消失 → 网关回落主域
server 块 → 子域**证书变成主域的、内容变成主站的**，本机 `push-ingest.mjs` 报 `fetch failed`
（TLS 主机名不匹配，不是 token 或后端的问题）。

治法是**把「接入」拆成两半**：PetCare 仓库只保留一句稳定的 `include`，观测台的 server 块
放进 release 树之外的宿主目录。此后主站发版不再影响本子域，改配置也不必等主站发版：

```
PetCare 仓库: docker-compose.yml  只读挂载 /opt/petcare/extra-confs → /etc/nginx/extra-confs
             docker/edge-nginx.conf 尾部一句 include /etc/nginx/extra-confs/*.conf;
宿主:        /opt/petcare/extra-confs/tibo-reset.conf  ← 配置本体（本仓库 deploy/petcare-gateway/ 是源）
```

另有一个 systemd 定时器每 2 分钟守护一次（`deploy/petcare-gateway/gateway-guard.sh`）：
只在该子域的配置确实不在位时才补（include 行丢了补 include、挂载也没了就退回整段注入），
补完先 `nginx -t` 再 `reload`，全程不重建容器。机制、落点与排障命令见
`deploy/petcare-gateway/README.md`。

⚠ 首次部署时注入的那一段仍然有效；**下一次 petcare 发布**带上 include 与挂载之后，
生效的就是 `/opt/petcare/extra-confs/tibo-reset.conf`（两份内容等价，不必手工删旧段）。

---

## 四、本机直推的凭据

数据由**本机**采集（住宅出口能过 Cloudflare，机房不能），采完直接 POST 给后端 ——
网页是请求时实时渲染的，所以这一步一做完、刷新页面就是新数据，**不需要重新构建、不需要重启容器**。

在**本机**建一个不进仓库的文件：

```bash
cat > ~/.tibo-ingest.env <<'EOF'
INGEST_URL=https://reset.example.com/api/ingest
INGEST_TOKEN=<与第二节第 2 步生成的那个串一致>
SITE_URL=https://reset.example.com          # 出镜像时用，见 2.1
EOF
chmod 600 ~/.tibo-ingest.env
```

这个文件的三个键各管一段：`INGEST_URL` / `INGEST_TOKEN` 是本机推送的收件地址与口令，
`SITE_URL` 是 `ship-image.sh` 构建时烤进 `og:url` / `og:image` 的对外地址。
放在同一份里是有意的 —— 真值只存一处，就不会出现「某个脚本里还留着旧域名」。

本机的采集自动化任务（WorkBuddy「Tibo Reset 采集（本机出口）」）第 6 步会读它并执行
`node scripts/push-ingest.mjs`。该文件不存在时脚本会打印「未配置 INGEST_URL，跳过境内推送」
并退出 0 —— 属正常跳过，不是错误。

---

## 五、校验清单

按顺序跑一遍，每步都该是预期结果：

```bash
# 0. TLS 装对了（主体是这个子域，且不是快过期的那张）
echo | openssl s_client -connect reset.example.com:443 2>/dev/null \
  | openssl x509 -noout -subject -dates
#    → subject=CN = reset.example.com / notAfter=Dec 21 07:59:59 2026 GMT

# 1. 进程与调度器状态
curl -s https://reset.example.com/api/health
#    → status: ok，且 collectIntervalMin: 0

# 2. 页面出得来，且是**实时渲染**的（不是兜底产物）
curl -s https://reset.example.com/ | head -c 300
#    → 有完整 HTML。若日志里出现「实时渲染失败，退回构建期产物」，说明 data 目录没数据

# 3. Docker 健康检查
docker inspect --format '{{.State.Health.Status}}' tibo-reset
#    → healthy

# 4. 数据能进得来（在**本机**跑，不是在服务器上）
cd ~/projects/tibo-reset
set -a; . ~/.tibo-ingest.env; set +a; node scripts/push-ingest.mjs
#    → ✓ 已推送：N 条记录 / M 条推文
#    再跑一次应该得到「服务端已有更新数据 … 本次载荷已丢弃」—— 幂等生效

# 5. 数据真的落盘了（服务器上）
docker exec tibo-reset ls -l --time-style=+%F_%T /app/data
#    → stats.json 的 mtime 应该是刚才那个时刻

# 6. 页面跟着变了
curl -s https://reset.example.com/ | grep -o 'id="gen"[^<]*<[^>]*>[^<]*' | head -1
#    → 「最近一次采集」的时刻 = 刚才推送的时刻
```

---

## 六、日常更新

| 要改什么 | 怎么做 | 要不要重新部署 |
|---|---|---|
| **数据** | 本机自动化每轮自动采集 + 直推 `/api/ingest` | ❌ 不需要，页面刷新即新 |
| **页面 / 后端代码** | 本机 `ship-image.sh` 出镜像 → 服务器 `update-image.sh` 换容器 | ✅ 需要（数据卷保住数据） |
| **OG 分享图** | 同上 —— 它只能在**构建期**出，接口改不了 | ✅ 需要 |
| **小程序里的文案与数字** | 本机 `node scripts/build.mjs` 重新生成 `snapshot.js`，随小程序包发布 | ❌ 与服务器镜像无关 |

⚠ **OG 分享图是这张表里最容易漏的一条。** `dist/og-image.png` 由 `scripts/og-image.mjs`
在构建期渲染成 PNG（@resvg/resvg-js 是 devDependency，运行镜像里没有它），所以
**接口改不了它**。结果是页面上的数字早就翻新了，而分享到微信/群里时卡片上还是上一次
构建时的数字 —— 实测踩到过：页面已是 0.29 天，卡片仍印着 10.1 天。
「数据变了不用重新部署」成立，「想让分享卡片跟上」不成立。

### 改代码的完整动作

本机一条、服务器一条：

```bash
# ① 【本机】重新出镜像（amd64；含最新的 OG 图与种子数据）
cd ~/projects/tibo-reset
scripts/ship-image.sh                                 # → ~/tibo-deploy/tibo-reset-amd64.tar.gz
```

```bash
# ② 【服务器】换上镜像并重启容器（失败自动回滚）
sudo bash update-image.sh
```

`update-image.sh` 与首次部署的 `deploy-remote.sh` 分工不同：首次部署要装证书、往网关
配置里追加 server 块 —— 那些都已就位，重跑会重复注入。所以更新脚本**只换容器**，并且：

| 它做的事 | 为什么 |
|---|---|
| 从 `/srv/tibo.env` 复用凭据 | 不重新生成 `INGEST_TOKEN`，就不存在「服务器换了口令、本机还在用旧的」这种 401 |
| 参数与旧容器逐项对齐 | 同名（网关按容器名找）、同网络 `edge_network`、同卷、同端口、`unless-stopped`、日志上限 10m×3 |
| 旧容器保留为 `tibo-reset-prev` | 留回滚点；任一步失败自动还原（含网关 reload） |
| 换完 `nginx -s reload` | **必需**，见下 |
| 自检用 `curl --resolve` | 腾讯云轻量不支持 hairpin NAT，机器内部访问自己的公网域名必然 000 |
| 核对记录总数仍是 54 | 少于 54 说明数据卷没挂对，当场失败而不是静默退回种子数据 |

**为什么 reload 是必需步骤**：网关配置里是 `proxy_pass http://tibo-reset:8787`
（容器名，不是宿主端口）。nginx 在**启动/reload 时解析一次容器名并缓存住**，换容器后
新容器拿到新 IP，不 reload 就会一直往旧 IP 打 → 502。配置内容一个字都没错，线上就是不通。

**为什么不用 `docker rm -f` 直接删**：脚本先 `stop` 再 `rename` 成 `tibo-reset-prev`，
新容器起不来时可以一步换回。确认稳定后再 `sudo docker rm tibo-reset-prev`。

### 数据不会丢

换镜像、重建容器都不碰 `/srv/tibo-data` —— 数据不在容器里，这是第二节把数据目录独立
出来、挂成卷的直接收益。（反过来说：`/app/data` 一旦没挂上，容器会用镜像里的种子数据
起一份「看起来正常但停在旧值」的数据，所以更新脚本把记录总数当成硬判据。）

备份数据：

```bash
tar czf ~/tibo-data-$(date +%F).tgz -C /srv/tibo-data .
```

---

## 七、排障

| 症状 | 先看什么 |
|---|---|
| 页面打不开 / 502 | `docker ps` 看容器活着没；`docker logs tibo-reset`；`curl http://127.0.0.1:8787/api/health`（服务器上跑，绕开 Nginx） |
| 页面能开但数字是旧的 | 日志里有没有「实时渲染失败，退回构建期产物」—— 有的话是 `/app/data` 没数据（卷没挂上？） |
| 页面显示「数据未更新」 | 本机采集停了。**这是有意的提示**，不是 bug（见 D-023） |
| 页面显示「数据采集异常」 | 数据里带着采集错误（`stats.json.errors`），看那条错误原文 |
| 本机推送报 401 | 两侧 `INGEST_TOKEN` 不一致：本机 `~/.tibo-ingest.env` vs 容器环境变量 |
| 本机推送报 503 | 容器没配 `INGEST_TOKEN`，写入入口是关闭的（这是刻意的，宁可关掉也不裸奔） |
| 小程序白屏 | 微信后台的 request 合法域名没配，或域名没备案。**小程序端会静默走 fail 回调**，先查这里 |
| 浏览器报证书不匹配 | 证书 SAN 只覆盖 `reset.example.com` —— 用别的域名（或 IP）访问必然不匹配，不是配置错。真装错了就按 3.2 重传 |
| 子域打开是**主站的内容**、证书也是主域的 | 网关里本子域的 server 块不在位（详见 3.3）。先看 `systemctl status tibo-gateway-guard.service` 与 `/var/log/tibo-gateway-guard.log`；确认后可手工跑一次 `/opt/tibo/gateway-guard.sh` |
| 本机推送报 `fetch failed`（不是 401/503） | 多半同上：TLS 主机名不匹配。用 `openssl s_client -connect reset.example.com:443 \| openssl x509 -noout -subject` 看主体是不是本子域 |
| https 打不开但 http 是 301 | 443 的 server 块没生效或证书路径写错。`sudo nginx -t` 会直接指出；`ss -lntp \| grep 443` 看端口在听没 |
| 证书快到期了 | **这是人工续期的证书，没有定时器可查**（见 3.2）。到期日 `2026-12-21`，去腾讯云控制台重签后按 3.2 替换，**不用重启容器** |
