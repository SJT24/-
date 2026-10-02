#!/bin/sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。请先安装 https://nodejs.org 的 LTS 版本。"
  exit 1
fi
echo "正在启动善鸡通AI：http://localhost:8080"
(sleep 1; command -v xdg-open >/dev/null && xdg-open http://localhost:8080) || true
exec node server.js
