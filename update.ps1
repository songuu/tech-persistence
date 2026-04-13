<#
.SYNOPSIS
    通用升级脚本 — 一键升级到任意版本

.DESCRIPTION
    默认升级到最新版本。也可以指定版本号升级到特定版本。
    每个版本函数只负责该版本相对于前一版本的增量变更。

.PARAMETER Version
    目标版本。可选值:
      (不传)  — 升级到最新版本 (LATEST_VERSION)
      v3.2    — 升级到 v3.2 (文档持久化工作流)
      v3.1    — 升级到 v3.1 (Obsidian 集成)
      v3      — 升级到 v3 (工作流层 + 复利循环)
      list    — 列出所有可用版本
      help    — 显示帮助

.EXAMPLE
    .\update.ps1
    升级到最新版本

.EXAMPLE
    .\update.ps1 v3.2
    只升级到 v3.2 的功能

.EXAMPLE
    .\update.ps1 list
    查看所有可用版本
#>

param(
    [Parameter(Position = 0)]
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeHome = Join-Path $env:USERPROFILE ".claude"

# ─── 版本定义 ───
$LATEST_VERSION = "v4"

$VERSIONS = @(
    @{ Name = "v3";   Desc = "工作流层 + 复利循环 (think/plan/work/review/compound/sprint)" },
    @{ Name = "v3.1"; Desc = "Obsidian 集成 (frontmatter/wikilinks)" },
    @{ Name = "v3.2"; Desc = "文档持久化工作流 (docs/plans/YYYY-MM-DD-<slug>.md)" },
    @{ Name = "v4";   Desc = "Skill 自迭代闭环 (diagnose/improve/eval/publish + /prototype)" }
)

# ─── 辅助函数 ───
function Write-OK($msg)      { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)    { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)     { Write-Host "  [XX] $msg" -ForegroundColor Red }
function Write-Section($msg) { Write-Host "`n=== $msg ===`n" -ForegroundColor Cyan }

function Safe-Copy($Src, $Dst) {
    if (Test-Path $Dst) {
        $backup = "$Dst.bak.$(Get-Date -Format 'yyyyMMddHHmm')"
        Copy-Item $Dst $backup -Force
        Write-Warn "$(Split-Path -Leaf $Dst) 已存在，备份到 $(Split-Path -Leaf $backup)"
    }
    Copy-Item $Src $Dst -Force
}

function Show-Help {
    Write-Host ""
    Write-Host "update.ps1 — 通用升级脚本" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "用法:" -ForegroundColor White
    Write-Host "  .\update.ps1              升级到最新版本 ($LATEST_VERSION)"
    Write-Host "  .\update.ps1 <version>    升级到指定版本"
    Write-Host "  .\update.ps1 list         列出所有可用版本"
    Write-Host "  .\update.ps1 help         显示此帮助"
    Write-Host ""
    Write-Host "示例:" -ForegroundColor White
    Write-Host "  .\update.ps1"
    Write-Host "  .\update.ps1 v3.2"
    Write-Host "  .\update.ps1 v3.1"
    Write-Host ""
}

function Show-VersionList {
    Write-Host ""
    Write-Host "可用版本:" -ForegroundColor Cyan
    Write-Host ""
    foreach ($v in $VERSIONS) {
        $marker = if ($v.Name -eq $LATEST_VERSION) { " (latest)" } else { "" }
        Write-Host ("  {0,-6}{1} — {2}" -f $v.Name, $marker, $v.Desc) -ForegroundColor White
    }
    Write-Host ""
}

function Test-ClaudeHome {
    if (-not (Test-Path $ClaudeHome)) {
        Write-Err "未找到 ~/.claude 目录。请先运行 install.ps1 -All"
        exit 1
    }

    $commandsDir = Join-Path $ClaudeHome "commands"
    if (-not (Test-Path $commandsDir)) {
        New-Item -ItemType Directory -Path $commandsDir -Force | Out-Null
        Write-OK "创建 ~/.claude/commands/"
    }
}

# ─── 版本升级函数 ───

# v3: 工作流层 + 复利循环
function Upgrade-To-V3 {
    Write-Section "升级到 v3：工作流层 + 复利循环"

    $newCommands = @("think.md", "plan.md", "work.md", "review.md", "compound.md", "sprint.md")
    foreach ($cmd in $newCommands) {
        $src = Join-Path $ScriptDir "user-commands\$cmd"
        if (Test-Path $src) {
            Safe-Copy $src (Join-Path $ClaudeHome "commands\$cmd")
            Write-OK ("/" + ($cmd -replace '\.md$', ''))
        } else {
            Write-Warn "未找到 $src，跳过"
        }
    }

    # CLAUDE.md 合并提示（不自动覆盖用户的个人偏好）
    $claudeMdSrc = Join-Path $ScriptDir "CLAUDE.md"
    $claudeMdDst = Join-Path $ClaudeHome "CLAUDE.md"
    if (Test-Path $claudeMdSrc) {
        if (Test-Path $claudeMdDst) {
            Write-Warn "~/.claude/CLAUDE.md 已存在，v3 的工程方法论未自动合并"
            Write-Host "     参考: $claudeMdSrc" -ForegroundColor Cyan
        } else {
            Copy-Item $claudeMdSrc $claudeMdDst -Force
            Write-OK "CLAUDE.md (v3 版本)"
        }
    }

    Write-OK "v3 升级完成"
}

# v3.1: Obsidian 集成
function Upgrade-To-V3_1 {
    Write-Section "升级到 v3.1：Obsidian 集成"

    # v3.1 的核心是脚本和 frontmatter 格式，命令文件已在 v3 同步
    # 这里只做占位提示，实际 Obsidian 初始化由 install.ps1 -Obsidian 完成
    Write-Host "  v3.1 的 Obsidian 集成主要是格式规范和 Vault 初始化：" -ForegroundColor Cyan
    Write-Host "  - 本能/会话/解决方案文档已使用 Obsidian 兼容的 frontmatter"
    Write-Host "  - 如需初始化 Vault，请运行: .\install.ps1 -Obsidian"
    Write-Host ""
    Write-OK "v3.1 升级完成"
}

# v3.2: 文档持久化工作流
function Upgrade-To-V3_2 {
    Write-Section "升级到 v3.2：文档持久化工作流"

    # 1. 同步最新的 6 个工作流命令（含文档持久化指令）
    Write-Host "  1/3 同步最新的工作流命令到 ~/.claude/commands/" -ForegroundColor White
    $workflowCommands = @("think.md", "plan.md", "work.md", "review.md", "compound.md", "sprint.md")
    foreach ($cmd in $workflowCommands) {
        $src = Join-Path $ScriptDir "user-commands\$cmd"
        if (Test-Path $src) {
            Safe-Copy $src (Join-Path $ClaudeHome "commands\$cmd")
            Write-OK ("/" + ($cmd -replace '\.md$', '') + " (含文档持久化指令)")
        } else {
            Write-Warn "未找到 $src，跳过"
        }
    }

    # 2. 初始化项目 docs/plans/ 目录
    Write-Host ""
    Write-Host "  2/3 初始化项目 docs/plans/ 目录" -ForegroundColor White
    $projectRoot = (Get-Location).Path
    $plansDir = Join-Path $projectRoot "docs\plans"
    if (-not (Test-Path $plansDir)) {
        New-Item -ItemType Directory -Path $plansDir -Force | Out-Null
        Write-OK "创建 $plansDir"
    } else {
        Write-OK "docs/plans/ 已存在"
    }

    # 3. 复制 TEMPLATE.md 到项目
    Write-Host ""
    Write-Host "  3/3 复制文档模板到项目" -ForegroundColor White
    $templateSrc = Join-Path $ScriptDir "docs\plans\TEMPLATE.md"
    $templateDst = Join-Path $plansDir "TEMPLATE.md"

    if (-not (Test-Path $templateSrc)) {
        Write-Err "源模板不存在: $templateSrc"
        Write-Err "请确保在 tech-persistence 项目根目录运行此脚本"
        return
    }

    # 如果当前项目就是 tech-persistence 本身，源和目标相同，跳过
    if ((Resolve-Path $templateSrc).Path -eq $templateDst) {
        Write-OK "当前项目就是 tech-persistence 本身，TEMPLATE.md 已就位"
    } elseif (Test-Path $templateDst) {
        Write-Warn "TEMPLATE.md 已存在，跳过（如需更新请手动替换）"
    } else {
        Copy-Item $templateSrc $templateDst -Force
        Write-OK "TEMPLATE.md → $templateDst"
    }

    Write-OK "v3.2 升级完成"
}

# v4: Skill 自迭代闭环
function Upgrade-To-V4 {
    Write-Section "升级到 v4：Skill 自迭代闭环"

    # 1. 同步新的 skill 生命周期命令
    Write-Host "  1/5 同步 Skill 自迭代命令到 ~/.claude/commands/" -ForegroundColor White
    $skillCmds = @("skill-diagnose.md", "skill-improve.md", "skill-eval.md", "skill-publish.md")
    foreach ($cmd in $skillCmds) {
        $src = Join-Path $ScriptDir "user-level\commands\$cmd"
        if (Test-Path $src) {
            Safe-Copy $src (Join-Path $ClaudeHome "commands\$cmd")
            Write-OK ("/" + ($cmd -replace '\.md$', ''))
        } else {
            Write-Warn "未找到 $src，跳过"
        }
    }

    # 2. 同步 /prototype 工作流命令
    Write-Host ""
    Write-Host "  2/5 同步 /prototype 命令到 ~/.claude/commands/" -ForegroundColor White
    $protoSrc = Join-Path $ScriptDir "user-commands\prototype.md"
    if (Test-Path $protoSrc) {
        Safe-Copy $protoSrc (Join-Path $ClaudeHome "commands\prototype.md")
        Write-OK "/prototype"
    }

    # 3. 同步更新后的 /compound 和 /learn
    Write-Host ""
    Write-Host "  3/5 升级 /compound 和 /learn" -ForegroundColor White
    $compoundSrc = Join-Path $ScriptDir "user-commands\compound.md"
    if (Test-Path $compoundSrc) {
        Safe-Copy $compoundSrc (Join-Path $ClaudeHome "commands\compound.md")
        Write-OK "/compound (含 skill 使用信号采集)"
    }
    $learnSrc = Join-Path $ScriptDir "user-level\commands\learn.md"
    if (Test-Path $learnSrc) {
        Safe-Copy $learnSrc (Join-Path $ClaudeHome "commands\learn.md")
        Write-OK "/learn (轻量版)"
    }

    # 4. 安装 prototype-workflow skill
    Write-Host ""
    Write-Host "  4/5 安装 prototype-workflow skill" -ForegroundColor White
    $protoSkillDir = Join-Path $ClaudeHome "skills\prototype-workflow"
    if (-not (Test-Path $protoSkillDir)) {
        New-Item -ItemType Directory -Path $protoSkillDir -Force | Out-Null
    }
    $protoSkillSrc = Join-Path $ScriptDir "user-level\skills\prototype-workflow\SKILL.md"
    if (Test-Path $protoSkillSrc) {
        Copy-Item $protoSkillSrc (Join-Path $protoSkillDir "SKILL.md") -Force
        Write-OK "prototype-workflow skill"
    }

    # 5. 创建 skill 自迭代相关的 homunculus 子目录
    Write-Host ""
    Write-Host "  5/5 初始化 skill-signals / skill-evals / skill-changelog 目录" -ForegroundColor White
    $homunculusDir = Join-Path $ClaudeHome "homunculus"
    foreach ($sub in @("skill-signals", "skill-evals", "skill-changelog")) {
        $dir = Join-Path $homunculusDir $sub
        if (-not (Test-Path $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        Write-OK "~/.claude/homunculus/$sub/"
    }

    Write-OK "v4 升级完成"
}

# ─── 主分发器 ───
function Invoke-Update {
    param([string]$Target)

    # 规范化参数
    $Target = $Target.ToLower().Trim()

    # 处理特殊命令
    switch ($Target) {
        ""        { $Target = $LATEST_VERSION }
        "latest"  { $Target = $LATEST_VERSION }
        "help"    { Show-Help; exit 0 }
        "-h"      { Show-Help; exit 0 }
        "--help"  { Show-Help; exit 0 }
        "list"    { Show-VersionList; exit 0 }
        "-l"      { Show-VersionList; exit 0 }
        "--list"  { Show-VersionList; exit 0 }
    }

    # 补全简写（v3 → v3.0 视为 v3）
    if ($Target -eq "v3.0") { $Target = "v3" }

    # 验证版本存在
    $knownVersions = $VERSIONS | ForEach-Object { $_.Name }
    if ($knownVersions -notcontains $Target) {
        Write-Err "未知版本: $Target"
        Write-Host ""
        Show-VersionList
        exit 1
    }

    # 检查环境
    Test-ClaudeHome

    Write-Host ""
    Write-Host "目标版本: $Target" -ForegroundColor Cyan
    if ($Target -eq $LATEST_VERSION) {
        Write-Host "(最新版本)" -ForegroundColor DarkGray
    }

    # 分发到对应的升级函数
    switch ($Target) {
        "v3"   { Upgrade-To-V3 }
        "v3.1" { Upgrade-To-V3_1 }
        "v3.2" { Upgrade-To-V3_2 }
        "v4"   { Upgrade-To-V4 }
    }

    # 完成提示
    Write-Host ""
    Write-Host "=== 升级完成 ===" -ForegroundColor Green
    Write-Host ""
    Write-Host "当前已升级到: $Target" -ForegroundColor White
    Write-Host ""
    if ($Target -eq "v3.2") {
        Write-Host "立即试用:" -ForegroundColor White
        Write-Host "  /sprint '你的需求描述'"
        Write-Host "  /think '小型需求' (单阶段使用也会生成文档)"
        Write-Host ""
        Write-Host "新文档位置: docs/plans/" -ForegroundColor White
        Write-Host ""
    } elseif ($Target -eq "v4") {
        Write-Host "Skill 自迭代闭环（五层架构）:" -ForegroundColor White
        Write-Host ""
        Write-Host "  L1 信号采集: /compound 自动记录 skill 使用信号"
        Write-Host "  L2 诊断:     /skill-diagnose [name]  — 步骤热力图 + 改进建议"
        Write-Host "  L3 改进提案: /skill-improve [name]   — 基于数据生成修改提案"
        Write-Host "  L4 验证:     /skill-eval [name] --diff — A/B 对比通过率"
        Write-Host "  L5 发布:     /skill-publish [name]   — 备份 + changelog + 回滚"
        Write-Host ""
        Write-Host "配套新增: /prototype 原型多轮收敛 + prototype-workflow skill"
        Write-Host "信号存储: ~/.claude/homunculus/skill-signals/"
        Write-Host "测试集:   ~/.claude/homunculus/skill-evals/"
        Write-Host ""
        Write-Host "P0 起步（先让数据跑 1-2 个月）:" -ForegroundColor White
        Write-Host "  正常使用 /compound，它会自动采集 skill 使用信号"
        Write-Host "  一段时间后运行 /skill-diagnose 查看第一份诊断报告"
        Write-Host ""
    }
}

# ─── 入口 ───
Invoke-Update -Target $Version
