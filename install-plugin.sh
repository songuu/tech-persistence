#!/usr/bin/env bash
# install-plugin.sh — Claude Code 2.x plugin installation
#
# 兼容 Claude Code 2.1+ plugin system (~/.claude/commands/ 已废弃).
# 把 tech-persistence 注册为 local marketplace 并安装为 user-scope plugin.
#
# 旧版 Claude Code 用户仍用 install.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/plugins/tech-persistence"

# ─────────────────────────────────────────────────────────────
# 前置检查
# ─────────────────────────────────────────────────────────────

if ! command -v claude >/dev/null 2>&1; then
  echo "✗ claude CLI 未找到。请先安装 Claude Code 2.x." >&2
  exit 1
fi

if [[ ! -f "$PLUGIN_DIR/.claude-plugin/plugin.json" ]]; then
  echo "✗ $PLUGIN_DIR/.claude-plugin/plugin.json 不存在." >&2
  echo "  请确认你在 tech-persistence 仓库根目录运行此脚本." >&2
  exit 1
fi

echo "━━━ Claude Code Plugin 安装 ━━━"
echo "Plugin: tech-persistence"
echo "Source: $PLUGIN_DIR"
echo ""

# ─────────────────────────────────────────────────────────────
# 验证 manifest
# ─────────────────────────────────────────────────────────────

echo "→ 验证 plugin manifest..."
claude plugin validate "$PLUGIN_DIR"

# ─────────────────────────────────────────────────────────────
# 注册 marketplace + 安装 plugin
# ─────────────────────────────────────────────────────────────

echo ""
echo "→ 注册本地 marketplace..."
claude plugin marketplace add "$PLUGIN_DIR" || {
  echo "  (marketplace 可能已注册过, 继续...)"
}

echo ""
echo "→ 安装 plugin..."
claude plugin install tech-persistence@tech-persistence-local

echo ""
echo "━━━ 安装完成 ━━━"
echo ""
echo "下一步:"
echo "  1. 重启 Claude Code 或在会话内跑 /reload-plugins"
echo "  2. 测试: /sprint 或 /think 应该响应"
echo ""
echo "卸载: claude plugin uninstall tech-persistence@tech-persistence-local"
