#!/bin/sh
# traffic-guard 安装脚本（独立附加组件，与 Open-Box 本体无关）。
#
# 做什么：
#   - 把 traffic-guard / tg-lib.mjs / 默认配置安装到 /opt/openbox-traffic-guard/
#   - 按平台注册服务：OpenWrt 用 procd（/etc/init.d/openbox-traffic-guard），
#     Debian/Ubuntu 等用 systemd（traffic-guard.service），Docker 环境只装文件并给出手动启动说明
# 不做什么：
#   - 不修改 /opt/open-box 里的任何文件（只读它的 etc/config.json 与自带 node/sing-box）
#   - 已存在的 traffic-guard.conf 不会被覆盖（升级安装时保留你的配置与状态）
#
# 用法：sh install-addon.sh

set -eu

SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TG_HOME=${TG_HOME:-/opt/openbox-traffic-guard}
OB_ROOT=${OB_ROOT:-/opt/open-box}

say() { printf '%s\n' "$*"; }
warn() { printf '警告：%s\n' "$*" >&2; }

[ "$(id -u)" = 0 ] || { echo "请用 root 运行" >&2; exit 1; }

say "==> 安装 traffic-guard 到 $TG_HOME"
mkdir -p "$TG_HOME/state"
cp "$SRC_DIR/traffic-guard" "$TG_HOME/traffic-guard"
cp "$SRC_DIR/tg-lib.mjs" "$TG_HOME/tg-lib.mjs"
chmod +x "$TG_HOME/traffic-guard"
if [ -f "$TG_HOME/traffic-guard.conf" ]; then
  say "    保留已有配置 traffic-guard.conf（新版示例见 traffic-guard.conf.example）"
  cp "$SRC_DIR/traffic-guard.conf.example" "$TG_HOME/traffic-guard.conf.example"
else
  cp "$SRC_DIR/traffic-guard.conf.example" "$TG_HOME/traffic-guard.conf"
  say "    已生成默认配置 traffic-guard.conf（守护范围默认=全部 selector 组，按需修改）"
fi

say "==> 环境检查"
ok=1
[ -d "$OB_ROOT" ] || { warn "未找到 Open-Box 安装目录 $OB_ROOT"; ok=0; }
[ -x "$OB_ROOT/bin/sing-box" ] || { warn "未找到内核 $OB_ROOT/bin/sing-box"; ok=0; }
[ -x "$OB_ROOT/node/bin/node" ] || { warn "未找到 Open-Box 自带 Node：$OB_ROOT/node/bin/node（本组件需要它解析内核配置）"; ok=0; }
command -v curl >/dev/null 2>&1 || { warn "未找到 curl（Open-Box 依赖里包含 curl，正常安装不会缺）"; ok=0; }
[ "$ok" = 1 ] && say "    内核 / Node / curl 均就绪"

say "==> 注册服务"
if [ -f /etc/rc.common ] && [ -d /etc/init.d ]; then
  cp "$SRC_DIR/openwrt.initd" /etc/init.d/openbox-traffic-guard
  chmod +x /etc/init.d/openbox-traffic-guard
  /etc/init.d/openbox-traffic-guard enable
  /etc/init.d/openbox-traffic-guard restart || /etc/init.d/openbox-traffic-guard start
  say "    OpenWrt procd 服务 openbox-traffic-guard 已启用并启动"
elif command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
  cp "$SRC_DIR/traffic-guard.service" /etc/systemd/system/traffic-guard.service
  systemctl daemon-reload
  systemctl enable --now traffic-guard
  say "    systemd 服务 traffic-guard 已启用并启动"
else
  warn "未检测到 OpenWrt / systemd（可能是 Docker 环境），已只安装文件、未注册服务。"
  say "    手动启动： $TG_HOME/traffic-guard run （前台）"
  say "    或后台：   nohup $TG_HOME/traffic-guard run >/dev/null 2>&1 &"
fi

say ""
say "完成。常用命令："
say "  查看状态： $TG_HOME/traffic-guard status"
say "  手动巡检： $TG_HOME/traffic-guard once"
say "  测单个节点：$TG_HOME/traffic-guard probe '<节点名>' full"
say "  改配置：   编辑 $TG_HOME/traffic-guard.conf 后重启服务"
