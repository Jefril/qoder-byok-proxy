#!/bin/bash
# 打全部补丁（重装/升级 Qoder 后使用）。macOS 不需要提权。
# 前台运行，输出直接可见；详细日志在 _apply_all_log.txt。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/scripts/apply-patches.js" "$@"
