# 后端服务镜像（两阶段构建）。
#
# ⚠ 必须部署在境外：x.com 在中国境内无法直连，而采集依赖抓取该域名。
#   若只能境内托管，请把 COLLECT_INTERVAL_MIN 设为 0 关闭内置调度，
#   改用 .github/workflows/collect.yml（境外 runner）采集，本服务只负责读取与预测。
#
# 为什么必须是两阶段：构建期要出 OG 分享图（F8），需要 @resvg/resvg-js，
# 而它是 devDependency。单阶段的话镜像里就只能留着 node_modules，
# 「运行时零依赖」（tech-selection D-002）当场破功 ——
# 而且 alpine 没有中文字体，构建还会静默出一张汉字全是空方框的坏卡片。
# 拆成两段之后：构建期的依赖与字体都留在构建层，运行镜像依然一个依赖都没有。

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
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk \
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
COPY data ./data
# package.json 不能少：src/lib/*.js 是 ESM，缺了 "type": "module" 会被当成 CommonJS
COPY package.json ./

# scripts/ 刻意不进镜像：其中 build.mjs / og-image.mjs 依赖构建期依赖，
# 放进一个没有 node_modules 的镜像里，只会让人以为它能跑。

ENV NODE_ENV=production \
    PORT=8787 \
    COLLECT_INTERVAL_MIN=30

EXPOSE 8787

# 健康检查打的是 /api/health，能同时反映进程存活与调度器状态
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
