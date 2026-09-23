# 后端服务镜像（两阶段构建）。
#
# 本镜像是**唯一的对外入口**：网页与 API 都由它提供。
#   网页在**请求时**用当前 data/ 实时渲染（调 src/lib/page.mjs，与构建期同一套代码），
#   所以数据一变、刷新即新，**不需要重新构建镜像**。dist/ 只在渲染失败时兜底。
#
# ⚠ /app/data 必须挂到容器外的卷。它是**唯一**的数据落点，而镜像层是只读的 ——
#   不挂卷的话，容器一重启就退回镜像里那份初始快照，/api/ingest 收来的数据全丢。
#   挂什么卷都行，但两种的初始化行为不同（2026-09-22 实测确认过）：
#     · named volume（-v tibo-data:/app/data）：首次使用时 Docker 自动填充镜像内容
#     · bind mount（-v /srv/tibo-data:/app/data）：**不会**填充，空目录就是空目录
#   后者由 server/entrypoint.sh 兜住：启动时若 /app/data 为空，就把 /app/seed-data
#   的种子数据拷进去。所以两种挂法都能「直接 docker run」，不必手工初始化。
#     docker run -v tibo-data:/app/data ...
#
# ⚠ 部署在**境内**（云服务器 / 容器平台）：小程序的 request 合法域名必须已 ICP 备案，
#   而境外域名备不了案 —— 这是微信侧的硬要求，它单独就决定了服务只能落在境内。
#
# ⚠ 因此**必须**把 COLLECT_INTERVAL_MIN 设为 0（镜像里已是默认值，别改）。
#   本镜像的出口是**云机房 IP**，而 x.com 的 Cloudflare 拦的正是机房 IP 段
#   （实测：同一时刻 runner 403 挑战页 / 住宅出口 200）。开着内置调度只会每轮
#   产生一条注定失败的记录，把真正的错误淹没。
#   采集由**本机（住宅出口）**的定时任务完成，采完**直接 POST 到 /api/ingest**，
#   本服务只负责接收、落盘、预测、出页面。见 docs/data-source.md §5。
#
# 为什么必须是两阶段：构建期要出 OG 分享图（F8），需要 @resvg/resvg-js，
# 而它是 devDependency。单阶段的话镜像里就只能留着 node_modules，
# 「运行时零依赖」（tech-selection D-002）当场破功 ——
# 而且 alpine 没有中文字体，构建还会静默出一张汉字全是空方框的坏卡片。
# 拆成两段之后：构建期的依赖与字体都留在构建层，运行镜像依然一个依赖都没有。
#
# ⚠ 构建期这一段的产物里，只有 OG 图是**运行期真的需要**的（网页本体已改为实时渲染）。
#   但 OG 图只能在构建期出（图片，接口改不了它），所以这段不能省。

# ============================ 构建阶段 ============================
# 用 debian 系而非 alpine：要装 fonts-noto-cjk，而 alpine 的字体包路径与
# og-image.mjs 的探测目录（/usr/share/fonts）对不上，不值得为此改探测逻辑。
FROM node:24-slim AS build

WORKDIR /app

# 先只拷 manifest：依赖没动时这一层能命中缓存，不用每次重装
COPY package.json package-lock.json ./
RUN npm ci

# ⚠ 必须在 build 之前装：没有 CJK 字体时 resvg 不报错，只是把每个汉字画成空方框。
#   og-image.mjs 里做了前置探测（找不到字体就拒绝出图），但不该靠降级活着。
#
# ⚠ fontconfig 必须显式列出，不能靠 fonts-noto-cjk 带进来 ——
#   它只是 fonts-noto-cjk 的 Recommends，而这里用了 --no-install-recommends，会被跳过。
#   缺了它 resvg 在 Linux 上枚举不到任何系统字体（字体文件明明在 /usr/share/fonts），
#   结果是**整张卡片一个字都不渲染**：og-image.mjs 的探测只查文件是否存在，
#   查不到「resvg 其实一个字体都没加载」这件事，于是它照样放行、静默出一张纯线条空图。
#   macOS 与 GitHub Actions 的 ubuntu 镜像都自带 fontconfig，所以只有本镜像会踩到。
# ⚠ 国内构建时这一层的 apt 源必须换掉（2026-09-23 实测踩到）：
#   deb.debian.org 在本机被 DNS 解析到 8.134.121.112（不是真正的 Fastly CDN），
#   直连 000、经代理 502 —— apt 层直接 exit code 100，而报错只说
#   "repository is not signed / 502 Bad Gateway"，一个字都不提「网络被污染」。
#
#   默认留空 = 沿用官方源，行为不变；scripts/ship-image.sh 探测到不通时自动传
#   --build-arg APT_MIRROR=mirrors.aliyun.com。只影响构建期装字体这一步，
#   与运行镜像无关（运行镜像里连 apt 都没有）。
ARG APT_MIRROR=""
RUN if [ -n "${APT_MIRROR}" ]; then \
      if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
      elif [ -f /etc/apt/sources.list ]; then \
        sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; \
      fi; \
    fi \
 && apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends fonts-noto-cjk fontconfig \
 && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY scripts ./scripts
COPY data ./data
COPY miniprogram ./miniprogram

# 产出 dist/index.html 与 dist/og-image.png。
# SITE_URL 不给就跳过 og:url / og:image —— 用 --build-arg SITE_URL=... 传入。
ARG SITE_URL=""
ENV SITE_URL=${SITE_URL}
RUN node scripts/build.mjs

# ============================ 运行阶段 ============================
# 零运行时依赖：没有 node_modules，只有源码与构建产物。
FROM node:24-alpine

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY server ./server
COPY src ./src
# 初始数据放 seed-data，由 entrypoint.sh 在数据卷为空时拷进 /app/data。
# 不直接放 /app/data：那会被挂载的卷盖掉，等于没有种子可用。
COPY data ./seed-data
# package.json 不能少：src/lib/*.js 是 ESM，缺了 "type": "module" 会被当成 CommonJS
COPY package.json ./

# /app/data 是运行时的数据落点（卷挂这里）。显式建出来 —— 没挂卷时 entrypoint
# 的探测会落在一个不存在的路径上，虽然逻辑上能兜住，但不如让它一直存在。
RUN mkdir -p /app/data && chmod +x /app/server/entrypoint.sh

# scripts/ 刻意不进镜像：其中 build.mjs / og-image.mjs 依赖构建期依赖，
# 放进一个没有 node_modules 的镜像里，只会让人以为它能跑。
# 注意：页面渲染逻辑**不在** scripts/ 下 —— 它是 src/lib/render.mjs + src/lib/page.mjs，
# 随下面的 `COPY src` 一起进镜像（零依赖，所以运行时跑得起来）。

# 默认关闭内置采集：本镜像跑在**机房出口**，采集必被 Cloudflare 挑战（见文件头说明）。
# 默认值取 0 而不是 30，是为了让「忘了设」这个错误不可能发生 —— 与 collect.yml 里
# 那条「阈值必须由周期推导」同一个思路：靠默认值与推导，不靠人的记性。
#
# SITE_URL 留空是有意的：域名属于**部署环境**的信息，写进镜像就等于把镜像绑死在一个
# 域名上（换域名要重新构建镜像）。留空时页面照常出，只是不输出 og:url / og:image。
# 运行时传：docker run -e SITE_URL=https://reset.example.com ...
ENV NODE_ENV=production \
    PORT=8787 \
    COLLECT_INTERVAL_MIN=0 \
    SITE_URL=""

EXPOSE 8787

# 健康检查打的是 /api/health，能同时反映进程存活与调度器状态
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# entrypoint 负责「空数据卷 → 填种子」，然后 exec 到 CMD ——
# 所以 PID 1 仍然是 node，SIGTERM 能直接到达服务进程（server/index.mjs 有优雅退出）。
ENTRYPOINT ["/app/server/entrypoint.sh"]
CMD ["node", "server/index.mjs"]
