<#
.SYNOPSIS
    v3 升级脚本 — 在已有 v2 安装上添加 Compound + gstack 融合层
.EXAMPLE
    .\upgrade-v3.ps1
#>

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeHome = Join-Path $env:USERPROFILE ".claude"

function Write-OK($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Section($msg) { Write-Host "`n=== $msg ===`n" -ForegroundColor Cyan }

function Safe-Copy($Src, $Dst) {
    if (Test-Path $Dst) {
        $backup = "$Dst.bak.$(Get-Date -Format 'yyyyMMddHHmm')"
        Copy-Item $Dst $backup -Force
        Write-Warn "$(Split-Path -Leaf $Dst) 已存在，备份到 $(Split-Path -Leaf $backup)"
    }
    Copy-Item $Src $Dst -Force
}

# ─── 检查 v2 是否已安装 ───
Write-Section "检查 v2 基础"

$v2Markers = @(
    (Join-Path $ClaudeHome "skills\continuous-learning\hooks\observe.js"),
    (Join-Path $ClaudeHome "homunculus\config.json"),
    (Join-Path $ClaudeHome "commands\learn.md")
)

$v2Installed = $true
foreach ($marker in $v2Markers) {
    if (-not (Test-Path $marker)) {
        Write-Warn "未找到 $marker"
        $v2Installed = $false
    }
}

if (-not $v2Installed) {
    Write-Host "  [!!] v2 基础未完整安装。请先运行 install.ps1 -All" -ForegroundColor Red
    Write-Host "  或者继续升级（将只安装 v3 新增命令）" -ForegroundColor Yellow
    $confirm = Read-Host "  继续? (y/N)"
    if ($confirm -ne 'y' -and $confirm -ne 'Y') { exit 0 }
}

Write-OK "v2 基础检查通过"

# ─── 安装 v3 新增命令 ───
Write-Section "安装 v3 新增命令（工作流层）"

$newCommands = @("think.md", "plan.md", "work.md", "review.md", "compound.md", "sprint.md")
foreach ($cmd in $newCommands) {
    $src = Join-Path $ScriptDir "user-commands\$cmd"
    if (Test-Path $src) {
        Safe-Copy $src (Join-Path $ClaudeHome "commands\$cmd")
        Write-OK ("命令 /" + ($cmd -replace '\.md$', ''))
    } else {
        Write-Warn "未找到 $src，跳过"
    }
}

# ─── 更新 CLAUDE.md ───
Write-Section "更新 CLAUDE.md"

$claudeMd = Join-Path $ClaudeHome "CLAUDE.md"
if (Test-Path $claudeMd) {
    Write-Warn "CLAUDE.md 已存在"
    Write-Host "  v3 的 CLAUDE.md 增加了工程方法论部分和角色模式说明" -ForegroundColor Cyan
    Write-Host "  建议手动合并: $ScriptDir\CLAUDE.md" -ForegroundColor Cyan
    Write-Host ""

    $confirm = Read-Host "  用 v3 版本覆盖？(y/N，选 N 则手动合并)"
    if ($confirm -eq 'y' -or $confirm -eq 'Y') {
        Safe-Copy (Join-Path $ScriptDir "CLAUDE.md") $claudeMd
        Write-OK "CLAUDE.md 已更新为 v3 版本（旧版已备份）"
    } else {
        Write-OK "保留现有 CLAUDE.md，请手动合并"
    }
} else {
    Copy-Item (Join-Path $ScriptDir "CLAUDE.md") $claudeMd -Force
    Write-OK "CLAUDE.md (v3 版本)"
}

# ─── 确保 docs/solutions/ 目录存在 ───
Write-Section "确保项目目录结构"

$projectRoot = (Get-Location).Path
$solutionsDir = Join-Path $projectRoot "docs\solutions"
if (-not (Test-Path $solutionsDir)) {
    New-Item -ItemType Directory -Path $solutionsDir -Force | Out-Null
    Write-OK "创建 docs/solutions/ — Compound 解决方案文档目录"
} else {
    Write-OK "docs/solutions/ 已存在"
}

$plansDir = Join-Path $projectRoot ".claude\plans"
if (-not (Test-Path $plansDir)) {
    New-Item -ItemType Directory -Path $plansDir -Force | Out-Null
    Write-OK "创建 .claude/plans/ — Think/Plan 输出目录"
} else {
    Write-OK ".claude/plans/ 已存在"
}

# ─── 完成 ───
Write-Host ""
Write-OK "v3 升级完成！"
Write-Host ""
Write-Host "  新增命令:" -ForegroundColor White
Write-Host "    /think    — CEO/产品视角审视需求"
Write-Host "    /plan     — 架构师视角生成实现计划"
Write-Host "    /work     — 工程师模式按计划执行"
Write-Host "    /review   — 多角度审查 (安全/性能/架构/质量/测试)"
Write-Host "    /compound — 复利步骤 (经验+本能+解决方案)"
Write-Host "    /sprint   — 全流程冲刺 (think->plan->work->review->compound)"
Write-Host ""
Write-Host "  保留的 v2 命令:" -ForegroundColor White
Write-Host "    /learn /session-summary /debug-journal /retrospective"
Write-Host "    /instinct-status /evolve /instinct-export /instinct-import"
Write-Host "    /review-learnings"
Write-Host ""
Write-Host "  工作流:" -ForegroundColor White
Write-Host "    大任务: /sprint '需求描述'"
Write-Host "    中任务: /plan -> 开发 -> /review -> /compound"
Write-Host "    小任务: 直接开发 -> /compound"
Write-Host ""
Write-Host "  关键变化:" -ForegroundColor White
Write-Host "    /compound 替代 /learn 成为会话结束的默认步骤"
Write-Host "    /compound = /learn + 解决方案文档 + review 发现整合"
Write-Host ""
