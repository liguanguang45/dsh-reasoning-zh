#!/bin/sh
# 一键安装 dsh-reasoning-zh（macOS / Linux）
set -e
cd "$(dirname "$0")"

echo "=========================================="
echo "  安装 dsh-reasoning-zh（让思考过程用中文）"
echo "=========================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[x] 没有找到 node 命令。"
  echo "    可以装一个 Node.js LTS：https://nodejs.org"
  echo "    或用 DSH 自带的 node，通常位于 ~/.dsh/dsh-runtimes/ 下。"
  exit 1
fi

node install.mjs
code=$?
echo
if [ "$code" -eq 0 ]; then
  echo "[ok] 安装完成。"
  echo "     下一步：完全退出并重新打开 DSH，然后在对话框输入 /reasoning-zh 回车验证。"
else
  echo "[x] 安装没有成功（退出码 $code）。请把上面的输出整段发给分享给你的人。"
fi
exit "$code"
