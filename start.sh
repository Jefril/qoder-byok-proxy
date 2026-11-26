#!/bin/bash
# Qoder BYOK 一键启动 / 停止 / 查状态（macOS 版，对应 Windows 的 start.cmd/start.ps1）
#
# 用法：
#   ./start.sh            启动三个后台服务
#   ./start.sh status     查状态
#   ./start.sh stop       停止
#   ./start.sh open       启动后打开控制台
#
# 它只负责起后台服务，不改 Qoder 的任何配置：
#   控制台        admin.js              http://127.0.0.1:3426
#   代理          proxy.js              127.0.0.1:8788  （IDE 用，MITM 私有协议）
#   OpenCode代理  opencode-go-proxy.mjs 127.0.0.1:8787  （Desktop 用，注入 x-opencode-session）
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
PROXY_DIR="$ROOT/qoder-proxy"
LOG_DIR="$ROOT/_start_logs"
CMD="${1:-start}"

port_open() { nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }

show_status() {
  echo ""
  echo "服务状态"
  for entry in "控制台:3426" "代理:8788" "OpenCode代理:8787"; do
    name="${entry%%:*}"; port="${entry##*:}"
    if port_open "$port"; then state="运行中"; else state="未启动"; fi
    printf "  %-12s 端口 %s  %s\n" "$name" "$port" "$state"
  done
  if port_open 3426; then
    # 问控制台拿补丁 / 证书 / 代理状态
    curl -s --max-time 10 http://127.0.0.1:3426/api/status | python3 -c '
import json,sys
try:
    s=json.load(sys.stdin)
    p=s.get("patches",{}); c=s.get("cert",{}); i=s.get("ide",{}); u=s.get("config",{}).get("upstream",{})
    print("  补丁      byok=%s experts=%s live=%s repowiki=%s"%(p.get("byok"),p.get("experts"),p.get("live"),p.get("repowiki")))
    print("  证书      已信任=%s"%c.get("trusted"))
    print("  IDE代理   %s"%(i.get("httpProxy") or "未设置"))
    print("  上游      %s  %s"%(u.get("baseUrl",""),u.get("model","")))
except Exception:
    print("  （控制台已监听但状态接口没响应，稍等几秒再看）")
' 2>/dev/null || echo "  （状态解析失败）"
  fi
  echo ""
}

stop_all() {
  echo ""
  echo "停止 Qoder BYOK 服务"
  any=0
  # launchd 接管的服务必须先卸载，否则 KeepAlive 会立刻把进程拉回来
  if launchctl list 2>/dev/null | grep -q com.qoder-byok; then
    uid=$(id -u)
    launchctl bootout "gui/$uid" "$HOME/Library/LaunchAgents/com.qoder-byok.admin.plist" 2>/dev/null
    launchctl bootout "gui/$uid" "$HOME/Library/LaunchAgents/com.qoder-byok.proxy.plist" 2>/dev/null
    launchctl bootout "gui/$uid" "$HOME/Library/LaunchAgents/com.qoder-byok.opencode.plist" 2>/dev/null
    echo "  launchd 自启服务已卸载（重新启用：./start.sh start 会改为手动运行）"
    any=1
  fi
  for pat in 'qoder-proxy/proxy\.js' 'qoder-proxy/admin\.js' 'qoder-proxy/opencode-go-proxy\.mjs'; do
    if pkill -f "$pat" 2>/dev/null; then any=1; fi
  done
  sleep 1
  show_status
  [ "$any" = "1" ] || echo "（本来就没在跑）"
}

start_all() {
  if [ ! -f "$PROXY_DIR/admin.js" ]; then
    echo "找不到 $PROXY_DIR/admin.js，本脚本要和 qoder-proxy 放在同一个目录"
    exit 1
  fi
  NODE="$(command -v node || true)"
  if [ -z "$NODE" ]; then
    echo "找不到 node：请先安装 Node.js（brew install node），或把它加入 PATH。"
    exit 1
  fi
  mkdir -p "$LOG_DIR"

  # 干净出网：剥掉启动终端可能带的环境代理（Desktop 注入的隧道、Clash 等），
  # 三个服务全部直连上游，行为与启动环境无关，拷到其他设备也一样。
  unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NODE_USE_ENV_PROXY UPSTREAM_PROXY 2>/dev/null || true

  echo ""
  echo "启动 Qoder BYOK 服务"
  echo "  node: $NODE"

  start_one() { # $1=名称 $2=文件 $3=端口
    if port_open "$3"; then
      printf "  %-8s 端口 %s 已在运行，跳过\n" "$1" "$3"
      return
    fi
    # 不用 ( cd && nohup & ) 的 subshell 形式：实测 subshell 会一直等后台 job 导致脚本不退出。
    # admin.js / proxy.js 都用 __dirname 定位文件，不依赖工作目录；stdin 指到 /dev/null 防挂起。
    nohup "$NODE" "$PROXY_DIR/$2" >>"$LOG_DIR/$1.out.log" 2>>"$LOG_DIR/$1.err.log" </dev/null &
    disown 2>/dev/null || true
    printf "  %-8s 启动中…\n" "$1"
  }
  start_one 控制台 admin.js 3426
  start_one 代理 proxy.js 8788
  start_one OpenCode代理 opencode-go-proxy.mjs 8787

  # 等端口起来（代理要先加载证书，给足时间）
  deadline=$((SECONDS + 45))
  while [ $SECONDS -lt $deadline ]; do
    if port_open 3426 && port_open 8788; then break; fi
    sleep 0.7
  done

  # OpenCode 代理给 Desktop 用：没起来只提示，不阻塞主服务
  if ! port_open 8787; then
    deadline2=$((SECONDS + 5))
    while [ $SECONDS -lt $deadline2 ]; do
      port_open 8787 && break
      sleep 0.5
    done
    port_open 8787 || echo "  （OpenCode代理 8787 未起来，Desktop 接入不可用；日志 $LOG_DIR/OpenCode代理.err.log）"
  fi

  failed=""
  port_open 3426 || failed="控制台(3426)"
  port_open 8788 || failed="$failed 代理(8788)"
  if [ -n "$failed" ]; then
    echo ""
    echo "有服务没起来：$failed"
    [ -f "$LOG_DIR/代理.err.log" ] && tail -12 "$LOG_DIR/代理.err.log" | sed 's/^/    /'
    echo "  完整日志在 $LOG_DIR"
    exit 1
  fi

  show_status
  echo "控制台：http://127.0.0.1:3426/"
  [ "$CMD" = "open" ] && open "http://127.0.0.1:3426/"
  return 0
}

case "$CMD" in
  stop)   stop_all ;;
  status) show_status ;;
  open)   start_all ;;
  *)      start_all ;;
esac
