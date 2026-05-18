#!/usr/bin/env pwsh
# install-plugin.ps1 — Claude Code 2.x plugin installation
#
# 兼容 Claude Code 2.1+ plugin system (~/.claude/commands/ 已废弃).
# 把 tech-persistence 注册为 local marketplace 并安装为 user-scope plugin.
#
# 旧版 Claude Code 用户仍用 install.ps1.

param(
  [switch]$All,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginDir = Join-Path $ScriptDir 'plugins\tech-persistence'

function Show-Help {
  Write-Host @"
Usage:
  powershell -ExecutionPolicy Bypass -File .\install-plugin.ps1 -All

Options:
  -All   Install the Tech Persistence Claude Code plugin.
  -Help  Show this help.
"@
}

if ($Help) {
  Show-Help
  exit 0
}

# -All is accepted to keep the Windows installer surface consistent. The
# plugin installer has only one install target, so no narrower mode is needed.

# ─────────────────────────────────────────────────────────────
# 前置检查
# ─────────────────────────────────────────────────────────────

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Error '✗ claude CLI 未找到。请先安装 Claude Code 2.x.'
  exit 1
}

if (-not (Test-Path (Join-Path $PluginDir '.claude-plugin\plugin.json'))) {
  Write-Error "✗ $PluginDir\.claude-plugin\plugin.json 不存在.`n  请确认你在 tech-persistence 仓库根目录运行此脚本."
  exit 1
}

Write-Host '━━━ Claude Code Plugin 安装 ━━━'
Write-Host 'Plugin: tech-persistence'
Write-Host "Source: $PluginDir"
Write-Host ''

# ─────────────────────────────────────────────────────────────
# 验证 manifest
# ─────────────────────────────────────────────────────────────

Write-Host '→ 验证 plugin manifest...'
claude plugin validate $PluginDir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# ─────────────────────────────────────────────────────────────
# 注册 marketplace + 安装 plugin
# ─────────────────────────────────────────────────────────────

Write-Host ''
Write-Host '→ 注册本地 marketplace...'
try {
  claude plugin marketplace add $PluginDir
} catch {
  Write-Host '  (marketplace 可能已注册过, 继续...)'
}

Write-Host ''
Write-Host '→ 安装 plugin...'
claude plugin install 'tech-persistence@tech-persistence-local'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host '━━━ 安装完成 ━━━'
Write-Host ''
Write-Host '下一步:'
Write-Host '  1. 重启 Claude Code 或在会话内跑 /reload-plugins'
Write-Host '  2. 测试: /sprint 或 /think 应该响应'
Write-Host ''
Write-Host '卸载: claude plugin uninstall tech-persistence@tech-persistence-local'
