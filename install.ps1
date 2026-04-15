<#
.SYNOPSIS
    Claude Code 自进化工程系统 — 完整安装脚本
.EXAMPLE
    .\install.ps1 -All
#>
param(
    [switch]$User,
    [switch]$Project,
    [switch]$All,
    [switch]$HooksOnly,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeHome = Join-Path $env:USERPROFILE ".claude"
$HomunculusDir = Join-Path $ClaudeHome "homunculus"

function Write-OK($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Section($msg) { Write-Host "`n=== $msg ===`n" -ForegroundColor Cyan }
function Ensure-Dir($p) { if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null } }
function Safe-Copy($s,$d) {
    if (Test-Path $d) { Copy-Item $d "$d.bak.$(Get-Date -Format 'yyyyMMddHHmm')" -Force }
    Copy-Item $s $d -Force
}
function Safe-CopyNew($s,$d) { if (-not (Test-Path $d)) { Copy-Item $s $d -Force } else { Write-Warn "$(Split-Path -Leaf $d) exists, skip" } }

function Build-SettingsJson {
    $hp = (Join-Path $ClaudeHome "skills/continuous-learning/hooks") -replace '\\','/'
    $o = [ordered]@{
        '$schema'='https://code.claude.com/schemas/settings.json'; autoMemoryEnabled=$true
        hooks=[ordered]@{
            SessionStart=@([ordered]@{matcher='*';hooks=@([ordered]@{type='command';command="node `"$hp/inject-context.js`" 2>nul || exit /b 0";timeout=5000})})
            PreToolUse=@([ordered]@{matcher='*';hooks=@([ordered]@{type='command';command="node `"$hp/observe.js`" pre 2>nul || exit /b 0";timeout=2000})})
            PostToolUse=@([ordered]@{matcher='*';hooks=@([ordered]@{type='command';command="node `"$hp/observe.js`" post 2>nul || exit /b 0";timeout=2000})})
            Stop=@([ordered]@{matcher='*';hooks=@([ordered]@{type='command';command="node `"$hp/evaluate-session.js`" 2>nul || exit /b 0";timeout=10000})})
        }
    }
    return ($o | ConvertTo-Json -Depth 10)
}

function Install-User {
    Write-Section "Installing user-level -> $ClaudeHome"

    # Directories
    @("commands","rules","skills/memory","skills/continuous-learning/hooks","skills/prototype-workflow") | ForEach-Object { Ensure-Dir (Join-Path $ClaudeHome $_) }
    @("instincts/personal","instincts/inherited","evolved/skills","evolved/commands","evolved/agents","projects","skill-signals","skill-evals","skill-changelog") | ForEach-Object { Ensure-Dir (Join-Path $HomunculusDir $_) }

    # CLAUDE.md
    Safe-CopyNew (Join-Path $ScriptDir "user-level/CLAUDE.md") (Join-Path $ClaudeHome "CLAUDE.md")
    Write-OK "CLAUDE.md"

    # Commands (19 total)
    Get-ChildItem (Join-Path $ScriptDir "user-level/commands") -Filter "*.md" | ForEach-Object {
        Safe-Copy $_.FullName (Join-Path $ClaudeHome "commands/$($_.Name)")
        Write-OK ("cmd /" + ($_.BaseName))
    }

    # Rules
    Safe-CopyNew (Join-Path $ScriptDir "user-level/rules/general-standards.md") (Join-Path $ClaudeHome "rules/general-standards.md")

    # Skills
    @("memory","continuous-learning","prototype-workflow") | ForEach-Object {
        $src = Join-Path $ScriptDir "user-level/skills/$_/SKILL.md"
        if (Test-Path $src) {
            Copy-Item $src (Join-Path $ClaudeHome "skills/$_/SKILL.md") -Force
            Write-OK "skill $_"
        }
    }

    # Hook scripts
    $hooksDir = Join-Path $ClaudeHome "skills/continuous-learning/hooks"
    Get-ChildItem (Join-Path $ScriptDir "scripts") -Filter "*.js" | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $hooksDir $_.Name) -Force
        Write-OK "hook $($_.Name)"
    }

    # Homunculus config
    $cfgDst = Join-Path $HomunculusDir "config.json"
    Safe-CopyNew (Join-Path $ScriptDir "user-level/homunculus/config.json") $cfgDst
    if (-not (Test-Path (Join-Path $HomunculusDir "projects.json"))) {
        Set-Content (Join-Path $HomunculusDir "projects.json") "{}" -Encoding UTF8
    }

    # Settings.json
    $us = Join-Path $ClaudeHome "settings.json"
    if (-not (Test-Path $us)) {
        Set-Content $us (Build-SettingsJson) -Encoding UTF8
        Write-OK "settings.json (4 hooks)"
    } elseif ((Get-Content $us -Raw) -notmatch "observe\.js") {
        Write-Warn "settings.json exists but no hooks - merge manually"
    }

    Write-Host "`n  [OK] User-level done! ($((Get-ChildItem (Join-Path $ClaudeHome 'commands') -Filter '*.md').Count) commands)" -ForegroundColor Green
}

function Install-Project {
    $root = (Get-Location).Path
    $cd = Join-Path $root ".claude"
    Write-Section "Installing project-level -> $cd"

    @("commands","rules","plans") | ForEach-Object { Ensure-Dir (Join-Path $cd $_) }
    Ensure-Dir (Join-Path $root "docs/solutions")

    Safe-CopyNew (Join-Path $ScriptDir "project-level/CLAUDE.md") (Join-Path $root "CLAUDE.md")
    $ps = Join-Path $cd "settings.json"
    if (-not (Test-Path $ps)) { Set-Content $ps (Build-SettingsJson) -Encoding UTF8; Write-OK "settings.json" }

    Get-ChildItem (Join-Path $ScriptDir "project-level/.claude/commands") -Filter "*.md" | ForEach-Object {
        Safe-Copy $_.FullName (Join-Path $cd "commands/$($_.Name)"); Write-OK ("cmd /" + $_.BaseName)
    }
    Get-ChildItem (Join-Path $ScriptDir "project-level/.claude/rules") -Filter "*.md" | ForEach-Object {
        Safe-CopyNew $_.FullName (Join-Path $cd "rules/$($_.Name)")
    }
    Write-OK "rules ($((@(Get-ChildItem (Join-Path $cd 'rules') -Filter '*.md' -ErrorAction SilentlyContinue)).Count) files)"

    Write-Host "`n  [OK] Project-level done!" -ForegroundColor Green
    Write-Host "  git add CLAUDE.md .claude/ docs/solutions/" -ForegroundColor Cyan
}

# Check Node.js
try { $nv = (& node --version 2>&1).ToString() -replace 'v',''; if ([int]($nv.Split('.')[0]) -lt 18) { throw "old" } } catch { Write-Host "[FAIL] Node.js >= 18 required" -ForegroundColor Red; exit 1 }

if ($Help) { Write-Host "`nUsage: .\install.ps1 -User | -Project | -All | -HooksOnly`n" }
elseif ($All) { Install-User; Install-Project }
elseif ($User) { Install-User }
elseif ($Project) { Install-Project }
elseif ($HooksOnly) { $hd = Join-Path $ClaudeHome "skills/continuous-learning/hooks"; Ensure-Dir $hd; Get-ChildItem (Join-Path $ScriptDir "scripts") -Filter "*.js" | ForEach-Object { Copy-Item $_.FullName (Join-Path $hd $_.Name) -Force }; Write-OK "hooks updated" }
else { Write-Host "`nUsage: .\install.ps1 -User | -Project | -All | -HooksOnly`n" }
