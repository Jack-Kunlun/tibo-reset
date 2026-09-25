#!/usr/bin/env bash
#
# 观测台网关自愈守护（由 tibo-gateway-guard.timer 每 2 分钟拉起一次）
#
# 为什么需要它
# ------------
# 观测台的 server 块不能放在 petcare 的 releases/<sha> 树里 —— 主站每发一次版，
# 那份网关配置就被换成新的，追加进去的内容随之消失（2026-09-25 真实发生过：
# 子域证书变成主域的、内容变成主站的、本机 push-ingest 报 fetch failed）。
#
# 现在的分工：
#   · petcare 仓库（docker/edge-nginx.conf）只保留**一句 include**：一个稳定的扩展点
#   · 配置本体在宿主 /opt/petcare/extra-confs/tibo-reset.conf —— 不在 release 树内，
#     发版不碰它
#
# 那还要守护做什么？防的是「两种机制都不在位」的回归，全都不是发版正常路径：
#   · 有人用**旧的 commit** 发版（那一版还没有 include 行）
#   · 挂载被改动 / 目录被清掉
# 判据与动作都很窄：只碰观测台自己的那一段配置，不触碰 petcare 的任何内容。
#
# 幂等：已生效时不写日志、不 reload、不碰任何文件（两次 grep 就退出）。

set -uo pipefail

CONF=/opt/petcare/current/docker/edge-nginx.conf
EXTRA_DIR=/opt/petcare/extra-confs
EXTRA="$EXTRA_DIR/tibo-reset.conf"
MASTER=/opt/tibo/tibo-reset.conf
INJECT=/opt/tibo/inject-nginx-conf.py
SNIPPET=/opt/tibo/edge-nginx-reset.snippet.conf
BACKUP_DIR=/opt/petcare/manual-backups
GATEWAY=petcare-edge-gateway
DOMAIN=reset.petcare-home.com
MARK=extra-confs
# 生效判据用**证书路径**这一行，不用域名：petcare 那份配置的 80 块 server_name 里也可能
# 出现域名，用域名判会在「443 块已被删、其它痕迹还在」时误判成已生效。
LIVE_MARK="certs/${DOMAIN}_bundle.crt"
LOG=/var/log/tibo-gateway-guard.log

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }
changed=0

# 1) 配置本体在不在？丢了就从主副本恢复（/opt/tibo 不在任何 release 树内）
if [ ! -s "$EXTRA" ]; then
  if install -d -m 755 "$EXTRA_DIR" && install -m 644 "$MASTER" "$EXTRA"; then
    log "已从主副本恢复 $EXTRA"
    changed=1
  else
    log "恢复 $EXTRA 失败"
    exit 1
  fi
fi

# 2) 已生效吗？两种机制任一在位即算生效：
#    · include 行在（新机制：本体走 extra-confs）
#    · 整段块在（旧机制：直接追加进网关配置 —— petcare 下一次发版前就是这个状态）
live=0
if grep -q "$MARK" "$CONF" 2>/dev/null || grep -qF "$LIVE_MARK" "$CONF" 2>/dev/null; then
  live=1
fi

if [ "$live" -eq 0 ]; then
  if ! install -d -m 700 "$BACKUP_DIR" || ! cp -a "$CONF" "$BACKUP_DIR/edge-nginx.conf.bak.$(date +%Y%m%d%H%M%S)"; then
    log "备份失败，未改配置"
    exit 1
  fi

  if docker exec "$GATEWAY" test -d /etc/nginx/extra-confs 2>/dev/null; then
    # 扩展目录仍挂着 —— 只补回 include 行（最小改动）
    if printf '\n# 由 tibo-gateway-guard 补回：这一版 release 里没有 include 行\ninclude /etc/nginx/extra-confs/*.conf;\n' >>"$CONF"; then
      log "include 行缺失，已补回（挂载仍在）"
      changed=1
    else
      log "写 include 失败"
      exit 1
    fi
  else
    # 扩展目录也没挂 —— 退回「整段注入」（这一版的 compose 还没有那个挂载）
    if python3 "$INJECT" "$CONF" "$SNIPPET" "$DOMAIN" >>"$LOG" 2>&1; then
      log "扩展目录未挂载，已退回整段注入"
      changed=1
    else
      log "整段注入失败，配置未生效，需人工介入"
      exit 1
    fi
  fi
fi

# 3) 有改动才「先验后热加载」，且只 reload（不重建容器，主站零中断）
if [ "$changed" -eq 0 ]; then
  exit 0
fi
if docker exec "$GATEWAY" nginx -t >>"$LOG" 2>&1; then
  docker exec "$GATEWAY" nginx -s reload >>"$LOG" 2>&1 && log "已 nginx -s reload"
else
  log "nginx -t 未通过，维持原状（备份在 ${BACKUP_DIR}，需人工介入）"
  exit 1
fi
