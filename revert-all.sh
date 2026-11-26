#!/bin/bash
# 全量回滚到官方状态（恢复原始 bundle 与 CSP、清代理设置）。macOS 不需要提权。
# 前台运行；详细日志在 _revert_all_log.txt。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/scripts/revert-patches.js" "$@"
