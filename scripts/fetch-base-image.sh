#!/bin/sh
#
# 把指定架构的 node 基础镜像搬进本机 docker —— 本机 daemon 拉不到 Docker Hub 时用。
#
# 为什么需要它：跨架构构建（本机 arm64 → 出 amd64 镜像）要求本地**先有** amd64 的
#   node:24-slim / node:24-alpine，构建才能开始。而本机的 Docker Desktop daemon
#   拉不到 Docker Hub（实测 auth.docker.io 直连超时、经代理回 502），
#   `docker build --platform linux/amd64` 会卡在 `failed to fetch oauth token`。
#
#   绕法是**起一个容器跑 skopeo**：容器内的网络走 Docker VM 的出口，可以配代理，
#   而 daemon 自己那条路配不上（~/.docker/config.json 的 proxies 字段只影响容器的
#   环境变量，管不到 daemon；Docker Desktop 的 settings 文件受 macOS TCC 保护，
#   脚本改不动）。所以让容器去下载、把结果 dump 成 tar，再 docker load 回来。
#
# 为什么不直接占用 node:24-slim 这个名字：本机原有那份是 arm64，不带 --platform 的
#   本地构建要靠它。所以这里统一打成 `node:24-slim-amd64` 这样的**带架构后缀**的名字，
#   两者共存。ship-image.sh 会在需要时临时切换、构建完原样还原。
#
# 用法：
#   scripts/fetch-base-image.sh                                  # amd64，走默认代理
#   scripts/fetch-base-image.sh --arch linux/arm64               # 换架构
#   scripts/fetch-base-image.sh --proxy http://host.docker.internal:7890
#
# 代理是**本机代理软件**的地址。容器里看宿主要用 host.docker.internal，
# 写 127.0.0.1 会指向容器自己（这是最容易搞错的一点）。没开代理就把 --proxy 传空：
#   scripts/fetch-base-image.sh --proxy ""
#
# 注意：凡变量后面紧跟中文或全角标点的地方一律写 ${var} —— /bin/sh 会把紧跟其后的
#   UTF-8 字节吃进变量名，`$CPU）` 会被当成变量 `CPU）`，在 set -u 下直接炸。
#
set -eu

cd "$(dirname "$0")/.."

ARCH="linux/amd64"
PROXY="http://host.docker.internal:7890"

while [ $# -gt 0 ]; do
  case "$1" in
    --arch)  ARCH="$2";  shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    -*) echo "未知参数：${1}（可用：--arch / --proxy）" >&2; exit 2 ;;
    *)  echo "多余参数：${1}" >&2; exit 2 ;;
  esac
done

case "$ARCH" in
  linux/amd64) CPU="amd64" ;;
  linux/arm64) CPU="arm64" ;;
  *) CPU=$(echo "$ARCH" | tr '/' '-') ;;
esac

# 搬运工容器：随便一个有 shell 的镜像都行，它跑在**本机架构**上，与目标架构无关
RUNNER=""
for cand in alpine node:24-alpine; do
  if docker image inspect "$cand" >/dev/null 2>&1; then RUNNER="$cand"; break; fi
done
if [ -z "$RUNNER" ]; then
  echo "⚠ 本地连 alpine 都没有，没法起搬运工容器（这一条不需要网络也可以有：本机已有的任意镜像都行）。" >&2
  exit 1
fi

DEST="${HOME}/tibo-deploy/base-images"
mkdir -p "$DEST"

echo "▸ 目标架构 ${ARCH}｜搬运工 ${RUNNER}｜代理 ${PROXY:-（不用）}"

for img in node:24-slim node:24-alpine; do
  tar="$DEST/$(echo "$img" | tr ':' '-')-${CPU}.tar"
  echo "▸ 拉 ${img}（${ARCH}）…"
  rm -f "$tar"

  docker run --rm \
    -e HTTP_PROXY="$PROXY" -e HTTPS_PROXY="$PROXY" \
    -e http_proxy="$PROXY" -e https_proxy="$PROXY" \
    -e NO_PROXY="localhost,127.0.0.1" \
    -v "$DEST":/out \
    "$RUNNER" sh -c "set -e
      apk add --no-cache skopeo >/dev/null 2>&1 || true
      command -v skopeo >/dev/null 2>&1 || { echo '装不上 skopeo（代理不通？）' >&2; exit 1; }
      skopeo copy --quiet --override-arch ${CPU} --override-os linux \
        docker://docker.io/library/${img} docker-archive:/out/$(basename "$tar")"

  # skopeo 的 docker-archive 不带 RepoTag，load 出来只有一个 image ID，
  # 所以这里自己认领名字（也正因为如此，不会覆盖本机原有的同名 tag）
  id=$(docker load -i "$tar" | sed -n 's/^Loaded image ID: //p')
  if [ -z "$id" ]; then
    echo "⚠ docker load 没拿到 image ID，tar 可能不完整：${tar}" >&2
    exit 1
  fi
  docker tag "$id" "${img}-${CPU}"
  got=$(docker image inspect "${img}-${CPU}" --format '{{.Os}}/{{.Architecture}}')
  echo "  ✓ ${img}-${CPU} → ${got}（$(du -h "$tar" | cut -f1)）"
done

echo ""
echo "✓ 就绪。接下来直接跑构建即可，ship-image.sh 会自动用这几份并还原 tag："
echo "    scripts/ship-image.sh"
echo ""
echo "  （中间产物 tar 留在 ${DEST}，合计约 400 MB。镜像已经装进 docker 了，"
echo "    若不想占这份磁盘，确认不需要留档后删掉整个目录即可。）"
