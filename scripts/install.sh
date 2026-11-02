#!/usr/bin/env bash
# 一键安装：检查 Node 版本 → 初始化 → 生成星图
set -e
cd "$(dirname "$0")/.."
need=$(node -e "console.log(process.versions.node.split('.')[0]*1)")
if [ "$need" -lt 22 ]; then
  echo "需要 Node.js >= 22.5（当前 $(node -v)）"; exit 1
fi
echo "► 初始化记忆库…"
node scripts/init.mjs
echo "► 生成星图…"
node tools/build-star-map.mjs
echo
echo "✅ 完成"
echo "   检索： node src/mg.mjs search \"关键词\""
echo "   星图： 打开 star-map.html"
