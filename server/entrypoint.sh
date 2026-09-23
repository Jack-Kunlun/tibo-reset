#!/bin/sh
# 首次启动时把镜像内的种子数据填进数据目录。
#
# 为什么需要它：把宿主目录 bind mount 到 /app/data 时，Docker **不会**把镜像里的
# 内容复制进去 —— 那是 named volume 才有的行为。挂一个空目录进来，容器里就是空的，
# 而空的 data/ 会让首屏走兜底路径：能显示，但数据停在构建那一刻。
# 有这一步，「直接 docker run」就得到一份立刻可用的数据，不必部署时手工 cp。
#
# ⚠ 已有数据时**一个字都不碰**：那是 /api/ingest 收来的，比镜像里的种子新。
#   判据是「目录是否为空」，所以重启容器不会覆盖，也不会重复拷贝。
set -e

if [ -z "$(ls -A /app/data 2>/dev/null)" ] && [ -d /app/seed-data ]; then
  n=$(ls -A /app/seed-data 2>/dev/null | wc -l | tr -d ' ')
  echo "▸ 数据目录为空，用镜像内的种子数据初始化（${n} 个文件）"
  cp -a /app/seed-data/. /app/data/
fi

exec "$@"
