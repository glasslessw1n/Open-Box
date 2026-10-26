#!/bin/sh
# traffic-guard 端到端测试：在本机用官方 sing-box 内核 + 假机场节点跑真实场景。
#
# 场景（假节点都是 127.0.0.1 上的 HTTP 代理桩，行为对应真实世界的节点状态）：
#   N1-blockpage     流量耗尽：任何请求回 200 + HTML 限流页
#   N2-blackhole     吞吐为零：接受请求后永不回数据
#   N3-healthy       健康节点
#   N4-throttle      被限速：数据以 5KB/s 滴回
#   N5-healthy-slow  健康但延时高（+600ms）
#   G-main（selector，当前=N1）：期望自动切换到 N3（可用里延时最低）
#   G-dead（selector，当前=N2，成员只有 N1/N2）：无可用节点，期望保持不动
#   第二次巡检：G-main 当前已健康，期望不切换、不误报
#
# 用法：sh tests/run-tests.sh（需要 node、curl、网络下载 sing-box 测试二进制；KEEP=1 保留现场）

set -u

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ADDON=$(CDPATH= cd -- "$HERE/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/tg-test.XXXXXX")
SINGBOX_VERSION=${SINGBOX_VERSION:-v1.14.4}
BIN_DIR=$HERE/.bin
SINGBOX=$BIN_DIR/sing-box
NODE=$(command -v node || true)
PIDS=
FAILS=0

cleanup() {
  # shellcheck disable=SC2086
  [ -n "$PIDS" ] && kill $PIDS 2>/dev/null
  [ "${KEEP:-}" = 1 ] && { echo "现场保留在 $WORK"; return; }
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

say() { printf '%s\n' "$*"; }
check() {  # check <描述> <0=通过>
  if [ "$2" = 0 ]; then say "  PASS  $1"; else say "  FAIL  $1"; FAILS=$((FAILS + 1)); fi
}

[ -n "$NODE" ] || { echo "需要 node" >&2; exit 1; }
command -v curl >/dev/null || { echo "需要 curl" >&2; exit 1; }

# ---------- 准备 sing-box 测试二进制 ----------
if [ ! -x "$SINGBOX" ]; then
  mkdir -p "$BIN_DIR"
  say "下载 sing-box $SINGBOX_VERSION（测试用）..."
  _tgz="$WORK/sing-box.tar.gz"
  curl -fsSL -o "$_tgz" "https://github.com/SagerNet/sing-box/releases/download/$SINGBOX_VERSION/sing-box-${SINGBOX_VERSION#v}-linux-amd64.tar.gz" \
    || { echo "sing-box 下载失败" >&2; exit 1; }
  tar -xzf "$_tgz" -C "$WORK"
  cp "$WORK/sing-box-${SINGBOX_VERSION#v}-linux-amd64/sing-box" "$SINGBOX"
  chmod +x "$SINGBOX"
fi
"$SINGBOX" version | head -1

# ---------- 假 Open-Box 安装目录 ----------
OB=$WORK/open-box
mkdir -p "$OB/bin" "$OB/etc" "$OB/node/bin" "$OB/data"
cp "$SINGBOX" "$OB/bin/sing-box"
ln -s "$NODE" "$OB/node/bin/node"
cp "$HERE/fixture-config.json" "$OB/etc/config.json"

# ---------- 安装被测组件到沙箱 ----------
GH=$WORK/guard
mkdir -p "$GH"
cp "$ADDON/traffic-guard" "$ADDON/tg-lib.mjs" "$GH/"
cat > "$GH/traffic-guard.conf" <<EOF
ENABLE=1
OB_ROOT=$OB
CHECK_INTERVAL=5
FAIL_STREAK=1
SWITCH_COOLDOWN=0
BLACKLIST_TTL=600
FULL_SCAN_INTERVAL=0
PROBE_PORT=17992
SMALL_URL=http://127.0.0.1:18204/generate_204
SMALL_TIMEOUT=4
FULL_URL=http://127.0.0.1:18205/__down?bytes=65536
FULL_TIMEOUT=20
MIN_BYTES=40000
MIN_SPEED_BPS=20480
REMOTE_DNS=1.1.1.1
EOF

export TG_HOME=$GH TG_VERBOSE=1

# ---------- 启动假源站与假节点 ----------
"$NODE" "$HERE/fake-provider.mjs" origin-204 18204 >/dev/null 2>&1 & PIDS="$PIDS $!"
"$NODE" "$HERE/fake-provider.mjs" origin-payload 18205 >/dev/null 2>&1 & PIDS="$PIDS $!"
"$NODE" "$HERE/fake-provider.mjs" node blockpage 18101 >/dev/null 2>&1 & PIDS="$PIDS $!"
"$NODE" "$HERE/fake-provider.mjs" node blackhole 18102 >/dev/null 2>&1 & PIDS="$PIDS $!"
"$NODE" "$HERE/fake-provider.mjs" node healthy 18103 >/dev/null 2>&1 & PIDS="$PIDS $!"
RATE_BPS=5000 "$NODE" "$HERE/fake-provider.mjs" node throttle 18104 >/dev/null 2>&1 & PIDS="$PIDS $!"
DELAY_MS=600 "$NODE" "$HERE/fake-provider.mjs" node healthy 18105 >/dev/null 2>&1 & PIDS="$PIDS $!"

# ---------- 启动“主内核”（fixture 配置） ----------
mkdir -p "$WORK/mainwd"
"$SINGBOX" run -c "$OB/etc/config.json" -D "$WORK/mainwd" > "$WORK/main-core.log" 2>&1 & PIDS="$PIDS $!"

api_now() {  # api_now <group> -> 当前节点名
  curl -s -H 'Authorization: Bearer testsecret' http://127.0.0.1:19095/proxies \
    | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).proxies[process.argv[1]].now)}catch(e){console.log("")}})' "$1"
}

_i=0
while [ $_i -lt 50 ]; do
  [ "$(api_now G-main)" = "N1-blockpage" ] && break
  _i=$((_i + 1)); sleep 0.2
done
say "== 初始状态 =="
[ "$(api_now G-main)" = "N1-blockpage" ]; check "G-main 初始为 N1-blockpage" $?
[ "$(api_now G-dead)" = "N2-blackhole" ]; check "G-dead 初始为 N2-blackhole" $?

# ---------- T1：tg-lib 单元检查 ----------
say "== T1 tg-lib =="
_line=$("$OB/node/bin/node" "$GH/tg-lib.mjs" api-info "$OB/etc/config.json")
[ "$_line" = "127.0.0.1:19095	testsecret" ]; check "api-info 读出控制器与密钥" $?
"$OB/node/bin/node" "$GH/tg-lib.mjs" probe-config "$OB/etc/config.json" N3-healthy 17992 "" 1.1.1.1 > "$WORK/probe.json" 2>"$WORK/probe.err"
[ -s "$WORK/probe.json" ]; check "probe-config 生成成功" $?
"$SINGBOX" check -c "$WORK/probe.json" 2>>"$WORK/probe.err"; check "probe 配置通过 sing-box check" $?
"$SINGBOX" check -c "$OB/etc/config.json" 2>/dev/null; check "fixture 配置通过 sing-box check" $?

# ---------- T2：第一次巡检（核心场景） ----------
# 故意给守护进程一个“有毒”的代理环境：http_proxy 指向死端口、no_proxy 含 127.0.0.1。
# 守护的探测请求必须无视这些变量、强制走探测通道——否则会把耗尽节点误判成健康（真实环境踩过的坑）。
export http_proxy="http://127.0.0.1:9" https_proxy="http://127.0.0.1:9" no_proxy="127.0.0.1,localhost" NO_PROXY="127.0.0.1,localhost"
say "== T2 第一次巡检（预计约 25 秒：含黑洞超时与限速全量下载） =="
sh "$GH/traffic-guard" once > "$WORK/once1.log" 2>&1
check "巡检进程正常退出" $?
[ "$(api_now G-main)" = "N3-healthy" ]; check "G-main 已切换到健康且延时最低的 N3-healthy" $?
[ "$(api_now G-dead)" = "N2-blackhole" ]; check "G-dead 无可用节点时保持不动" $?
grep -q '已自动切换' "$GH/state/traffic-guard.log"; check "日志记录了自动切换" $?
grep -q 'G-dead.*全部候选节点均不可用\|全部候选节点均不可用' "$GH/state/traffic-guard.log"; check "日志记录了 G-dead 无可用节点" $?
grep -q 'N1-blockpage」真实流量探测失败' "$GH/state/traffic-guard.log"; check "限流页节点被判失败（非 204 响应）" $?
grep -q 'slow-' "$GH/state/traffic-guard.log"; check "限速被识别（slow）" $?
[ -s "$GH/state/blacklist.tsv" ]; check "黑名单已写入" $?

# ---------- T3：第二次巡检（健康现状不应被打扰） ----------
say "== T3 第二次巡检 =="
_switches_before=$(grep -c '已自动切换' "$GH/state/traffic-guard.log")
sh "$GH/traffic-guard" once > "$WORK/once2.log" 2>&1
check "第二次巡检正常退出" $?
[ "$(api_now G-main)" = "N3-healthy" ]; check "G-main 仍为 N3-healthy" $?
_switches_after=$(grep -c '已自动切换' "$GH/state/traffic-guard.log")
[ "$_switches_before" = "$_switches_after" ]; check "健康时未发生多余切换" $?

say ""
if [ "$FAILS" = 0 ]; then
  say "全部测试通过。"
else
  say "$FAILS 项失败。守护日志尾部："
  tail -n 30 "$GH/state/traffic-guard.log" 2>/dev/null
  say "主内核日志尾部："
  tail -n 20 "$WORK/main-core.log" 2>/dev/null
  exit 1
fi
