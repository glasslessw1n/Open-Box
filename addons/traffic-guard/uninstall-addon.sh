#!/bin/sh
# traffic-guard 卸载脚本：停用并删除服务注册与程序文件。
# 默认保留 /opt/openbox-traffic-guard/traffic-guard.conf 与 state/（配置和日志），
# 加 --purge 则整目录删除。不会动 /opt/open-box 的任何内容。
#
# 用法：sh uninstall-addon.sh [--purge]

set -eu

TG_HOME=${TG_HOME:-/opt/openbox-traffic-guard}

[ "$(id -u)" = 0 ] || { echo "请用 root 运行" >&2; exit 1; }

if [ -x /etc/init.d/openbox-traffic-guard ]; then
  /etc/init.d/openbox-traffic-guard stop 2>/dev/null || true
  /etc/init.d/openbox-traffic-guard disable 2>/dev/null || true
  rm -f /etc/init.d/openbox-traffic-guard
  echo "已移除 OpenWrt 服务 openbox-traffic-guard"
fi
if [ -f /etc/systemd/system/traffic-guard.service ]; then
  systemctl disable --now traffic-guard 2>/dev/null || true
  rm -f /etc/systemd/system/traffic-guard.service
  systemctl daemon-reload 2>/dev/null || true
  echo "已移除 systemd 服务 traffic-guard"
fi
# 兜底：结束可能还在跑的守护进程（按完整路径匹配，避免误杀）
for pid in $(pgrep -f "$TG_HOME/traffic-guard run" 2>/dev/null || true); do
  kill "$pid" 2>/dev/null || true
done

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$TG_HOME"
  echo "已删除 $TG_HOME（含配置与状态）"
else
  rm -f "$TG_HOME/traffic-guard" "$TG_HOME/tg-lib.mjs" "$TG_HOME/traffic-guard.conf.example"
  rm -rf "$TG_HOME/state/probe"
  echo "已删除程序文件；保留了 $TG_HOME/traffic-guard.conf 与 state/ 日志（如需全删：sh uninstall-addon.sh --purge）"
fi
echo "卸载完成。Open-Box 本体未受任何影响。"
