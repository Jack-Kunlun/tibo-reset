# 网关接入件（reset.petcare-home.com）

观测台没有自己的入口，它借用 PetCare 主站那台服务器上**已有的容器化网关**
（`petcare-edge-gateway`，独占 80/443）。本目录是这次接入的全部产物。

## 为什么不能「把 server 块追加进网关配置」

最初就是那么做的，代价是 **PetCare 每发一次版，观测台就掉一次**：

| 环节 | 事实 |
|---|---|
| 网关配置在哪 | `<release 树>/docker/edge-nginx.conf`，由 PetCare 的发布流程整体替换 |
| 切 release 的机制 | `/opt/petcare/current` 是指向 `releases/<sha>` 的**软链**，发版即改指向 |
| 于是追加的内容 | 随旧 release 一起失效 —— 网关回落主域 server 块：**证书变主域的、内容变主站的** |

2026-09-25 真实发生：12:04 主站切 release，12:26 本机 `push-ingest.mjs` 报 `fetch failed`
（TLS 主机名不匹配），观测台域名整块显示成 PetCare 官网。

## 现在的分工

```
PetCare 仓库（上游，非本仓库）            tibo-reset 仓库（本目录）
  docker-compose.yml                       tibo-reset.extra.conf   ← 配置本体
    └ 只读挂载 /opt/petcare/extra-confs     gateway-guard.sh        ← 自愈守护
  docker/edge-nginx.conf                    tibo-gateway-guard.*    ← systemd 定时器
    └ 尾部一句 include ──────────┐
                                 ▼
        宿主 /opt/petcare/extra-confs/*.conf  →  容器 /etc/nginx/extra-confs/*.conf
```

- **PetCare 只多背一句 `include`**（stable，一次加完不用再动）；子站配置本体在 release 树
  之外，发版不碰它，改它也**不必等 PetCare 发版**。
- 通配 include 匹配不到文件时 nginx **不报错**，所以 `/opt/petcare/extra-confs` 为空、
  或观测台临时下线，都不影响主站。

## 服务器上的落点

| 路径 | 内容 |
|---|---|
| `/opt/petcare/extra-confs/tibo-reset.conf` | 配置本体（= 本目录 `tibo-reset.extra.conf`，sha256 一致） |
| `/opt/tibo/tibo-reset.conf` | 主副本：本体文件丢失时由此恢复 |
| `/opt/tibo/gateway-guard.sh` | 自愈守护脚本 |
| `/opt/tibo/inject-nginx-conf.py`<br>`/opt/tibo/edge-nginx-reset.snippet.conf` | 兜底用的整段注入器与片段（见下） |
| `/etc/systemd/system/tibo-gateway-guard.{service,timer}` | 每 2 分钟跑一次守护 |
| `/var/log/tibo-gateway-guard.log` | 只在**出事时**写一行（正常时一条不写） |

## 守护为什么还需要

`include` 是上游给的一句，仍可能因为**非正常路径**再次消失：有人用旧 commit 发版
（那一版还没有 include 行）、挂载被改动、目录被清掉。守护每 2 分钟检查一次，
按收到的状态选最小动作，且**只碰观测台自己那一段**：

| 状态 | 动作 |
|---|---|
| include 行在 / 整段块在 | 什么都不做（两次 grep 后退出） |
| 两者都不在，扩展目录仍挂着 | 往网关配置尾部补回 include 行 |
| 两者都不在，扩展目录也没挂 | 退回整段注入（旧机制，兼容还没带上挂载的 release） |
| 本体文件丢了 | 从 `/opt/tibo/tibo-reset.conf` 恢复 |

任一动作之后都**先 `nginx -t` 再 `nginx -s reload`**，只热加载、不重建容器（主站零中断）；
配置改动一律先备份到 `/opt/petcare/manual-backups/`。

## 怎么验证它真的在工作

```bash
# 定时器在跑、下一次什么时候
systemctl list-timers tibo-gateway-guard.timer --no-pager

# 上一次执行结果（exit 0 = 一切正常或已修复）
systemctl status tibo-gateway-guard.service --no-pager

# 出事时才会有内容；**文件不存在 = 从未出过事，属正常**，不是守护没跑
tail -20 /var/log/tibo-gateway-guard.log 2>/dev/null || echo "无日志 = 一直幂等通过"

# 守护有没有真的在跑，看这个 —— 不要靠日志文件是否存在来判断
systemctl is-active tibo-gateway-guard.timer

# 端到端：从**外部**看证书主体是不是本子域（服务器内部受 hairpin NAT 限制，不能用域名自测）
echo | openssl s_client -connect reset.petcare-home.com:443 2>/dev/null | openssl x509 -noout -subject -dates
```

## 激活扩展点（一次性，需要 PetCare 侧发布流程）

扩展点是**上游的改动**，光有本目录的产物不会自己生效。但**不激活也不影响可用性** ——
没激活时守护走「整段注入」兜底分支，主站发版后 2 分钟内自动恢复。

要让「发版不碰子站」真正成立，需要按顺序做完这三步：

| 步骤 | 在哪做 | 做什么 |
|---|---|---|
| 1 | PetCare 仓库 | 合并 `feat/edge-gateway-extra-confs`（= 一句 include + 只读挂载 + server-init 建目录） |
| 2 | PetCare 发布流程 | 手动触发 `deploy.yml`，新 release 才带上 include 行与挂载定义 |
| 3 | 服务器 | `docker compose up -d edge-gateway` 让挂载生效（**这一步会重建网关容器，主站与 admin 有短暂中断**） |

判断激活成功：`grep -c extra-confs /opt/petcare/current/docker/edge-nginx.conf` 返回 1
（未激活时为 0，此时靠追加段撑着）。

## 手工改配置的正确姿势

改完**不用重启容器**，一条 reload 即可（网关配置是单文件 bind mount，原地写才生效）：

```bash
docker exec petcare-edge-gateway nginx -t && docker exec petcare-edge-gateway nginx -s reload
```

⛔ 不要用 `docker compose up -d` 重建网关 —— 那会中断主站与 admin。
⛔ 不要把新文件 `mv` 到网关配置上 —— 单文件挂载认的是 inode，`mv` 换 inode 后容器里读到的
仍是旧内容（症状：配置改完、`nginx -t` 通过、reload 成功，线上一点变化都没有）。
