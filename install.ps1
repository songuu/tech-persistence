<#
.SYNOPSIS
    Claude Code 技术沉淀系统 v2 - Windows PowerShell 安装脚本
.EXAMPLE
    .\install.ps1 -All
#>

param(
    [switch]$User,
    [switch]$Project,
    [switch]$All,
    [switch]$HooksOnly,
    [switch]$Obsidian,
    [string]$VaultPath,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeHome = Join-Path $env:USERPROFILE ".claude"
$HomunculusDir = Join-Path $ClaudeHome "homunculus"

function Write-OK($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Info($msg)  { Write-Host "  [..] $msg" -ForegroundColor Cyan }
function Write-Section($msg) { Write-Host "`n=== $msg ===`n" -ForegroundColor Cyan }

function Ensure-Dir($Path) {
    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Safe-Copy($Src, $Dst) {
    if (Test-Path $Dst) {
        $backup = "$Dst.bak.$(Get-Date -Format 'yyyyMMddHHmm')"
        Copy-Item $Dst $backup -Force
        Write-Warn "$(Split-Path -Leaf $Dst) 已存在，备份到 $(Split-Path -Leaf $backup)"
    }
    Copy-Item $Src $Dst -Force
}

function Safe-CopyNoOverwrite($Src, $Dst) {
    if (Test-Path $Dst) {
        Write-Warn "$(Split-Path -Leaf $Dst) 已存在，跳过"
        return
    }
    Copy-Item $Src $Dst -Force
}

# ── 生成 settings.json ──
function Build-SettingsJson {
    $hooksPath = (Join-Path $ClaudeHome "skills/continuous-learning/hooks") -replace '\\', '/'

    $obj = [ordered]@{
        '$schema' = 'https://json.schemastore.org/claude-code-settings.json'
        autoMemoryEnabled = $true
        hooks = [ordered]@{
            SessionStart = @(
                [ordered]@{
                    matcher = '*'
                    hooks = @(
                        [ordered]@{
                            type = 'command'
                            command = "node `"$hooksPath/inject-context.js`" 2>/dev/null || exit 0"
                            timeout = 5000
                        }
                    )
                }
            )
            PreToolUse = @(
                [ordered]@{
                    matcher = '*'
                    hooks = @(
                        [ordered]@{
                            type = 'command'
                            command = "node `"$hooksPath/observe.js`" pre 2>/dev/null || exit 0"
                            timeout = 2000
                        }
                    )
                }
            )
            PostToolUse = @(
                [ordered]@{
                    matcher = '*'
                    hooks = @(
                        [ordered]@{
                            type = 'command'
                            command = "node `"$hooksPath/observe.js`" post 2>/dev/null || exit 0"
                            timeout = 2000
                        }
                    )
                }
            )
            Stop = @(
                [ordered]@{
                    matcher = '*'
                    hooks = @(
                        [ordered]@{
                            type = 'command'
                            command = "node `"$hooksPath/evaluate-session.js`" 2>/dev/null || exit 0"
                            timeout = 10000
                        }
                    )
                }
            )
        }
    }

    return ($obj | ConvertTo-Json -Depth 10)
}

# ══════════════════════════════════════════════
function Install-Hooks {
    Write-Section "安装自学习 Hook 脚本"

    $hooksDir = Join-Path $ClaudeHome "skills\continuous-learning\hooks"
    Ensure-Dir $hooksDir

    Copy-Item (Join-Path $ScriptDir "scripts\observe.js") (Join-Path $hooksDir "observe.js") -Force
    Write-OK "observe.js -> PreToolUse/PostToolUse 观察捕获"

    Copy-Item (Join-Path $ScriptDir "scripts\evaluate-session.js") (Join-Path $hooksDir "evaluate-session.js") -Force
    Write-OK "evaluate-session.js -> Stop 会话评估 + 本能提取"

    Copy-Item (Join-Path $ScriptDir "scripts\inject-context.js") (Join-Path $hooksDir "inject-context.js") -Force
    Write-OK "inject-context.js -> SessionStart 上下文注入"
}

# ══════════════════════════════════════════════
function Install-Homunculus {
    Write-Section "初始化 Homunculus 知识存储"

    @(
        "instincts\personal", "instincts\inherited",
        "evolved\skills", "evolved\commands", "evolved\agents",
        "projects"
    ) | ForEach-Object { Ensure-Dir (Join-Path $HomunculusDir $_) }

    $configDst = Join-Path $HomunculusDir "config.json"
    if (-not (Test-Path $configDst)) {
        Copy-Item (Join-Path $ScriptDir "user-level\homunculus\config.json") $configDst -Force
        Write-OK "config.json"
    } else {
        Write-Warn "config.json 已存在，保留现有"
    }

    $registryDst = Join-Path $HomunculusDir "projects.json"
    if (-not (Test-Path $registryDst)) {
        Set-Content -Path $registryDst -Value "{}" -Encoding UTF8
        Write-OK "projects.json"
    }

    Write-OK "Homunculus 目录结构就绪"
}

# ══════════════════════════════════════════════
function Install-User {
    Write-Section "安装用户级别配置 -> $ClaudeHome"

    Ensure-Dir (Join-Path $ClaudeHome "commands")
    Ensure-Dir (Join-Path $ClaudeHome "rules")
    Ensure-Dir (Join-Path $ClaudeHome "skills\memory")
    Ensure-Dir (Join-Path $ClaudeHome "skills\continuous-learning")

    # CLAUDE.md
    Safe-CopyNoOverwrite (Join-Path $ScriptDir "user-level\CLAUDE.md") (Join-Path $ClaudeHome "CLAUDE.md")
    if (Test-Path (Join-Path $ClaudeHome "CLAUDE.md")) { Write-OK "CLAUDE.md" }

    # Commands
    $cmds = @("learn.md", "review-learnings.md", "session-summary.md", "instinct-status.md", "evolve.md", "instinct-export.md", "instinct-import.md")
    foreach ($cmd in $cmds) {
        $src = Join-Path $ScriptDir "user-level\commands\$cmd"
        if (Test-Path $src) {
            Safe-Copy $src (Join-Path $ClaudeHome "commands\$cmd")
            Write-OK ("命令 /" + ($cmd -replace '\.md$', ''))
        }
    }

    # Rules
    Safe-CopyNoOverwrite (Join-Path $ScriptDir "user-level\rules\general-standards.md") (Join-Path $ClaudeHome "rules\general-standards.md")

    # Skills
    Copy-Item (Join-Path $ScriptDir "user-level\skills\memory\SKILL.md") (Join-Path $ClaudeHome "skills\memory\SKILL.md") -Force
    Copy-Item (Join-Path $ScriptDir "user-level\skills\continuous-learning\SKILL.md") (Join-Path $ClaudeHome "skills\continuous-learning\SKILL.md") -Force
    Write-OK "技能 memory + continuous-learning"

    Install-Hooks
    Install-Homunculus

    # Settings.json
    $userSettings = Join-Path $ClaudeHome "settings.json"
    if (Test-Path $userSettings) {
        $content = Get-Content $userSettings -Raw
        if ($content -match "observe\.js") {
            Write-Warn "settings.json 已包含 Hook 配置，跳过"
        } else {
            Write-Warn "settings.json 已存在但无 Hook 配置，请手动合并"
        }
    } else {
        $json = Build-SettingsJson
        Set-Content -Path $userSettings -Value $json -Encoding UTF8
        Write-OK "settings.json (含 4 Hook 配置)"
    }

    Write-Host ""
    Write-OK "用户级别安装完成！"
    Write-Host ""
    Write-Host "  已安装:" -ForegroundColor White
    Write-Host "    命令: /learn /review-learnings /session-summary"
    Write-Host "          /instinct-status /evolve /instinct-export /instinct-import"
    Write-Host "    技能: memory, continuous-learning"
    Write-Host "    Hook: SessionStart, PreToolUse, PostToolUse, Stop"
    Write-Host "    存储: $HomunculusDir"
    Write-Host ""
    Write-Host "  下一步:" -ForegroundColor White
    Write-Host "    1. 编辑 $ClaudeHome\CLAUDE.md 填写个人信息"
    Write-Host "    2. 重启 Claude Code"
    Write-Host "    3. 正常开发 - 系统自动观察和学习"
    Write-Host ""
}

# ══════════════════════════════════════════════
function Install-Project {
    $projectRoot = (Get-Location).Path
    $claudeDir = Join-Path $projectRoot ".claude"

    Write-Section "安装项目级别配置 -> $claudeDir"

    try {
        $null = & git rev-parse --is-inside-work-tree 2>&1
        Write-OK "检测到 Git 仓库"
    } catch {
        Write-Warn "当前目录不是 Git 仓库"
        $confirm = Read-Host "  继续? (y/N)"
        if ($confirm -ne 'y' -and $confirm -ne 'Y') {
            Write-Info "已取消"; return
        }
    }

    Ensure-Dir (Join-Path $claudeDir "commands")
    Ensure-Dir (Join-Path $claudeDir "rules")
    Ensure-Dir (Join-Path $claudeDir "skills\session-learning")
    Ensure-Dir (Join-Path $projectRoot "docs\tech-learnings\sessions")

    Safe-CopyNoOverwrite (Join-Path $ScriptDir "project-level\CLAUDE.md") (Join-Path $projectRoot "CLAUDE.md")

    $projSettings = Join-Path $claudeDir "settings.json"
    if (Test-Path $projSettings) {
        $content = Get-Content $projSettings -Raw
        if ($content -match "observe\.js") {
            Write-Warn ".claude/settings.json 已包含 Hook 配置，跳过"
        } else {
            Write-Warn ".claude/settings.json 已存在但无 Hook，请手动合并"
        }
    } else {
        $json = Build-SettingsJson
        Set-Content -Path $projSettings -Value $json -Encoding UTF8
        Write-OK ".claude/settings.json (含 4 Hook)"
    }

    $cmds = @("learn.md", "retrospective.md", "debug-journal.md")
    foreach ($cmd in $cmds) {
        Safe-Copy (Join-Path $ScriptDir "project-level\.claude\commands\$cmd") (Join-Path $claudeDir "commands\$cmd")
        Write-OK ("命令 /" + ($cmd -replace '\.md$', ''))
    }

    $rules = @("architecture.md", "debugging-gotchas.md", "performance.md", "testing-patterns.md", "api-conventions.md")
    foreach ($rule in $rules) {
        Safe-CopyNoOverwrite (Join-Path $ScriptDir "project-level\.claude\rules\$rule") (Join-Path $claudeDir "rules\$rule")
    }
    Write-OK "规则模板 ($($rules.Count) 个领域)"

    $hooksCheck = Join-Path $ClaudeHome "skills\continuous-learning\hooks\observe.js"
    if (-not (Test-Path $hooksCheck)) {
        Write-Warn "用户级 Hook 未安装，正在安装..."
        Install-Hooks
        Install-Homunculus
    }

    Write-Host ""
    Write-OK "项目级别安装完成！"
    Write-Host ""
    Write-Host "  提交到 Git:" -ForegroundColor White
    Write-Host "    git add CLAUDE.md .claude/"
    Write-Host "    git commit -m 'chore: add Claude Code tech persistence'"
    Write-Host ""
}

# ══════════════════════════════════════════════
function Show-Help {
    Write-Host ""
    Write-Host "Claude Code 技术沉淀系统 v2 - Windows 安装脚本" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "用法:"
    Write-Host "  .\install.ps1 -User        安装用户级别"
    Write-Host "  .\install.ps1 -Project     安装项目级别"
    Write-Host "  .\install.ps1 -All         同时安装两者"
    Write-Host "  .\install.ps1 -HooksOnly   只更新 Hook 脚本"
    Write-Host "  .\install.ps1 -Help        显示帮助"
    Write-Host ""
}

# ══════════════════════════════════════════════
function Install-Obsidian {
    Write-Section "Obsidian Vault 集成"

    $vault = if ($VaultPath) { $VaultPath } else { $HomunculusDir }

    & node (Join-Path $ScriptDir "scripts\init-obsidian-vault.js") --vault-path "$vault"

    $snippet = Join-Path $vault "_mcp-config-snippet.json"
    if (Test-Path $snippet) {
        Write-Host ""
        Write-Info "将以下 MCP 配置合并到 ~/.claude/settings.json:"
        Write-Host ""
        Get-Content $snippet
        Write-Host ""
    }

    Write-OK "Obsidian 集成完成"
    Write-Host ""
    Write-Host "  下一步:" -ForegroundColor White
    Write-Host "    1. 用 Obsidian 打开 vault: $vault"
    Write-Host "    2. 安装推荐插件: Dataview, Templater, Graph Analysis"
    Write-Host "    3. 将 _mcp-config-snippet.json 合并到 Claude Code 配置"
    Write-Host ""
}

# ══════════════════════════════════════════════
# 主入口
# ══════════════════════════════════════════════
try {
    $nodeVer = (& node --version 2>&1).ToString() -replace 'v', ''
    $major = [int]($nodeVer.Split('.')[0])
    if ($major -lt 18) {
        Write-Host "[FAIL] Node.js 版本过低 ($nodeVer), 需要 >= 18" -ForegroundColor Red
        exit 1
    }
    Write-Host "  [OK] Node.js $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "[FAIL] 未检测到 Node.js, 请先安装 https://nodejs.org" -ForegroundColor Red
    exit 1
}

if ($Help) { Show-Help }
elseif ($All) { Install-User; Install-Project }
elseif ($User) { Install-User }
elseif ($Project) { Install-Project }
elseif ($HooksOnly) { Install-Hooks; Install-Homunculus; Write-OK "Hook 脚本已更新" }
elseif ($Obsidian) { Install-Obsidian }
else { Show-Help }
