#!/bin/sh
#
# 把整套服务（网页 + API + 预测/信号分析）打成一个镜像文件，服务器直接 load 启动。
#
# 为什么走「本机构建 → 传文件」而不是「服务器上 git clone + docker build」：
#   服务器上只需要 docker —— 不要 git、不要 node、不要 npm，也不需要在境内
#   那个网络里去拉 Docker Hub。构建只发生在一台机器上，少一整类失败。
#
# ⚠ **最要紧的一条：架构必须匹配。**
#   本机是 Apple Silicon（arm64），而腾讯云 Ubuntu 64bit 的实例基本是 x86_64。
#   `docker build` 不写 --platform 时产出的是**本机架构**的镜像，搬到 x86_64 服务器上
#   会 `exec format error` 起不来 —— 而那个报错里一个字都不提「架构」。
#   所以这里默认 `--platform linux/amd64`。
#   到服务器上 `uname -m` 确认：x86_64 → 用默认；aarch64 → 加 --arch linux/arm64。
#
# 用法：
#   scripts/ship-image.sh                          # 只在本机产出 tar.gz
#   scripts/ship-image.sh root@203.0.113.10        # 产出并 scp 过去
#   scripts/ship-image.sh root@1.2.3.4 --arch linux/arm64
#   scripts/ship-image.sh --out /tmp/x.tar.gz      # 指定产物路径
#
# ⚠ SITE_URL 没有默认值 —— 与 Dockerfile / build.mjs / acceptance.mjs 同一约定：
#   域名是**部署环境**的信息，不进仓库。按顺序取：--site → 环境变量 → 本机凭据文件
#   `~/.tibo-ingest.env`（600，不进仓库）。三处都没有就直接报错。
#   为什么不像别的脚本那样给个占位默认值：构建期会把 SITE_URL 烤进 og:url /
#   og:image 与 OG 分享图，给占位默认值等于「脚本跑成功了、产出里印的却是错域名」——
#   这种「成功但错了」比直接失败难发现得多（OG 图印旧数字那次就是这么来的）。
#
# 注意：凡变量后面**紧跟中文或全角标点**的地方，一律写成 ${var}。
#   /bin/sh 解析变量名时会把紧跟其后的 UTF-8 字节也吃进名字里 ——
#   写 `$alt（` 会被当成变量 `alt（`，在 set -u 下直接 unbound variable 炸掉
#   （实测踩过：脚本前 85 行都跑完了，报错只指向那一行，很容易误以为是变量没定义）。
#   后面跟空格或 ASCII 标点时没这个问题，所以只有中文旁边需要加花括号。
#
set -eu

cd "$(dirname "$0")/.."

# 真实域名只从环境变量起步；--site 与下面的本机凭据文件都会覆盖它。
SITE_URL="${SITE_URL:-}"
ARCH="linux/amd64"
DEST=""
OUT=""
# 空 = 自动探测（见下方「apt 源」段）；也可用 --apt-mirror 显式指定。
APT_MIRROR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --out)  OUT="$2";  shift 2 ;;
    --site) SITE_URL="$2"; shift 2 ;;
    --apt-mirror) APT_MIRROR="$2"; shift 2 ;;
    -*) echo "未知参数：${1}（可用：--arch / --out / --site / --apt-mirror）" >&2; exit 2 ;;
    *)  DEST="$1"; shift ;;
  esac
done

# SITE_URL 的回落顺序：--site（上面已写进变量）→ 环境变量 → 本机凭据文件。
# 用一份本机凭据文件而不是散落的默认值：真值只存一处，也就不会出现
# 「某处还留着旧域名、跑起来却是成功的」。
if [ -z "$SITE_URL" ] && [ -f "$HOME/.tibo-ingest.env" ]; then
  SITE_URL="$(sed -n 's|^SITE_URL=||p' "$HOME/.tibo-ingest.env" | head -1)"
  if [ -n "$SITE_URL" ]; then
    echo "▸ SITE_URL 取自本机凭据文件 ~/.tibo-ingest.env"
  fi
fi
if [ -z "$SITE_URL" ]; then
  echo "✗ 缺少 SITE_URL —— 域名属于部署环境，不写进仓库，所以这里刻意不留默认值。" >&2
  echo "  它会被烤进 og:url / og:image 与 OG 分享图，给个占位默认值会变成「成功但印错域名」。" >&2
  echo "  用法：SITE_URL=https://你的域名 sh scripts/ship-image.sh [目标]" >&2
  echo "  或写进 ~/.tibo-ingest.env（推荐，chmod 600）：SITE_URL=https://你的域名" >&2
  exit 2
fi

case "$ARCH" in
  linux/amd64) CPU="amd64" ;;
  linux/arm64) CPU="arm64" ;;
  *) CPU=$(echo "$ARCH" | tr '/' '-') ;;
esac
IMAGE="tibo-reset:$CPU"
[ -n "$OUT" ] || OUT="$HOME/tibo-deploy/tibo-reset-$CPU.tar.gz"

# 前置检查：基础镜像得先在本地，且架构对得上。
# 本机的 docker daemon 连不上 Docker Hub（实测 auth.docker.io 直连超时、经代理也是 502），
# 所以跨架构构建**不能**指望它自己拉。缺了就直说，别让 build 抛个 502 让人对着报错猜。
#
# 「本地有、但架构不对」是最常见的一档：本机 arm64，而要出 amd64 镜像。
# 这时不报错，改用本地缓存的 `<tag>-<cpu>` 版本（scripts/fetch-base-image.sh 拉的那种），
# 构建完**原样还原** —— 直接覆盖会毁掉本机 tag，之后不带 --platform 的本地构建会
# 报「platform does not match」，而那个报错同样不提「是本脚本改的」。
SWAPPED=""
restore_base_tags() {
  [ -n "$SWAPPED" ] || return 0
  for pair in $SWAPPED; do
    t=${pair%%=*}; id=${pair#*=}
    if [ -n "$id" ]; then
      docker tag "$id" "$t" >/dev/null 2>&1 || true
    else
      docker rmi "$t" >/dev/null 2>&1 || true
    fi
  done
  SWAPPED=""
  echo "✓ 基础镜像 tag 已还原"
}
trap restore_base_tags EXIT INT TERM

missing=""
for base in node:24-slim node:24-alpine; do
  have=$(docker image inspect "$base" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || true)
  if [ "$have" = "$ARCH" ]; then
    continue
  fi

  alt="$base-$CPU"
  althave=$(docker image inspect "$alt" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || true)
  if [ "$althave" = "$ARCH" ]; then
    saved=$(docker image inspect "$base" --format '{{.Id}}' 2>/dev/null || true)
    docker tag "$alt" "$base"
    SWAPPED="$SWAPPED $base=$saved"
    echo "▸ ${base} 本地是 ${have:-空}，临时切到 ${alt}（${ARCH}），构建完还原"
    continue
  fi

  missing="$missing $base(现为 ${have:-本地无}，缓存 $alt ${althave:-也没有})"
done
if [ -n "$missing" ]; then
  echo "⚠ 基础镜像的本地版本与目标架构 $ARCH 不符：" >&2
  echo "   $missing" >&2
  echo "" >&2
  echo "   本机 daemon 拉不到 Docker Hub。两种解法见 docs/deploy.md「本机拉不到 Docker Hub 时」。" >&2
  exit 1
fi

# ── apt 源（构建期装字体用） ────────────────────────────────────────────
# 构建期要装 CJK 字体（否则 OG 分享图里的汉字全是空方框），而 deb.debian.org 在国内
# 常被 DNS 解析到坏地址 —— 实测本机解析成 8.134.121.112，直连 000、经代理 502，
# apt 层于是 exit code 100，报错只说 "not signed / 502 Bad Gateway"，不提网络。
#
# 探的路径就是 apt 真正要取的那个索引文件：探首页 200 不代表索引取得到
# （mirrors.cloud.tencent.com 首页 302，但它的 /debian 是通的，所以别拿首页当判据）。
if [ -z "$APT_MIRROR" ]; then
  if ! curl -s -o /dev/null --noproxy '*' --max-time 8 \
       "http://deb.debian.org/debian/dists/bookworm/InRelease"; then
    # ⚠ 用清华而不是阿里云 —— 这条是踩出来的，别看错：
    #   阿里云的**索引**是通的（几 KB 的文件全正常，前 8 个依赖包都下载成功），
    #   但 54 MB 的 fonts-noto-cjk 会反复 `Ign:` 最终变成
    #     Err: ... Connection failed [IP: 183.232.185.55 80]   → apt exit 100
    #   报错只说「连接失败」，一个字不提「这个源的大文件下不完」。
    #   实测同一个包：阿里云 45 秒只下来 14.8 MB 然后断流；
    #   清华 4.9 秒下完 56,547,048 字节（约 11.5 MB/s）。
    #   结论：**「索引拿得到」不等于「包能下完」** —— 判据只能看大文件。
    APT_MIRROR="mirrors.tuna.tsinghua.edu.cn"
    echo "▸ deb.debian.org 取不到索引，构建期 apt 源切到 ${APT_MIRROR}"
  fi
fi

echo "▸ 构建 ${IMAGE}（${ARCH}）"
docker build --platform "$ARCH" \
  --build-arg "SITE_URL=$SITE_URL" \
  --build-arg "APT_MIRROR=$APT_MIRROR" \
  -t "$IMAGE" .
# 构建一结束就还原，别拖到脚本末尾 —— 中间还要 save/gzip/scp 好几分钟
restore_base_tags

echo "▸ 导出到 $OUT"
mkdir -p "$(dirname "$OUT")"
docker save "$IMAGE" | gzip > "$OUT"

# 校验和：几万行的二进制走 scp 是可能悄悄截断的，服务器侧要对一次
( cd "$(dirname "$OUT")" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256" )
echo "✓ 产物 ${OUT}（$(ls -lh "$OUT" | awk '{print $5}')）"
cat "$OUT.sha256"

if [ -n "$DEST" ]; then
  echo "▸ 传到 $DEST:/srv/"
  scp "$OUT" "$OUT.sha256" "$DEST:/srv/"
fi

cat <<EOF

── 接下来在服务器上执行 ───────────────────────────────
cd /srv
sha256sum -c $(basename "$OUT").sha256        # 先核对传输完整
gunzip -c $(basename "$OUT") | docker load
export INGEST_TOKEN=<与本机 ~/.tibo-ingest.env 里那串一致>
mkdir -p /srv/tibo-data
docker run -d --restart always --name tibo-reset \\
  -p 127.0.0.1:8787:8787 \\
  -v /srv/tibo-data:/app/data \\
  -e SITE_URL=$SITE_URL \\
  -e INGEST_TOKEN="\$INGEST_TOKEN" \\
  $IMAGE

# 活着没（在服务器上跑，绕开 Nginx）
curl -s http://127.0.0.1:8787/api/health
EOF
