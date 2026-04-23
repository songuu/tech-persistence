<#
.SYNOPSIS
    Tech Persistence Codex plugin installer.
.EXAMPLE
    .\install-codex.ps1 -All
#>
param(
    [switch]$User,
    [switch]$Project,
    [switch]$All,
    [switch]$ImportClaude,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
$CodexHome = Join-Path $HomeDir ".codex"
$HomunculusDir = Join-Path $CodexHome "homunculus"
$AgentsPluginsDir = Join-Path $HomeDir ".agents\plugins"
$UserPluginsRoot = Join-Path $HomeDir "plugins"
$PluginName = "tech-persistence"
$PluginSource = Join-Path $ScriptDir "plugins\$PluginName"
$PluginTarget = Join-Path $UserPluginsRoot $PluginName

function Write-OK($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Section($msg) { Write-Host "`n=== $msg ===`n" -ForegroundColor Cyan }
function Ensure-Dir($path) { if (-not (Test-Path $path)) { New-Item -ItemType Directory -Path $path -Force | Out-Null } }

function Show-Help {
    Write-Host @"
Tech Persistence for Codex

Usage:
  powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -User
  powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -Project
  powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -All
  powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -All -ImportClaude

Options:
  -User          Install the Codex plugin to ~/plugins/tech-persistence and register marketplace.json.
  -Project       Create .codex project directories and project templates.
  -All           Run -User and -Project.
  -ImportClaude  Copy ~/.claude/homunculus to ~/.codex/homunculus when the Codex target does not exist.
  -Help          Show this help.
"@
}

function Test-Node {
    try {
        $version = (& node --version 2>&1).ToString() -replace 'v',''
        if ([int]($version.Split('.')[0]) -lt 18) { throw "Node.js >= 18 required" }
    } catch {
        Write-Host "[FAIL] Node.js >= 18 required" -ForegroundColor Red
        exit 1
    }
}

function Convert-CodexText($text) {
    return $text `
        -replace 'Claude Code', 'Codex' `
        -replace 'Claude', 'Codex' `
        -replace 'CLAUDE\.md', 'AGENTS.md' `
        -replace '~\/\.claude\/homunculus', '~/.codex/homunculus' `
        -replace '\.claude', '.codex'
}

function Copy-CodexText($source, $target, [switch]$NoOverwrite) {
    if ($NoOverwrite -and (Test-Path $target)) {
        Write-Warn "$(Split-Path -Leaf $target) exists, skip"
        return
    }
    Ensure-Dir (Split-Path -Parent $target)
    $content = Get-Content $source -Raw
    Set-Content $target (Convert-CodexText $content) -Encoding UTF8
}

function Build-Plugin {
    $builder = Join-Path $PluginSource "scripts\build-codex-plugin.js"
    if (-not (Test-Path $builder)) { throw "Missing builder: $builder" }
    & node $builder
    if ($LASTEXITCODE -ne 0) { throw "Codex plugin build failed" }
}

function Update-Marketplace {
    Ensure-Dir $AgentsPluginsDir
    $marketplacePath = Join-Path $AgentsPluginsDir "marketplace.json"
    $entry = [ordered]@{
        name = $PluginName
        source = [ordered]@{
            source = "local"
            path = "./plugins/$PluginName"
        }
        policy = [ordered]@{
            installation = "AVAILABLE"
            authentication = "ON_INSTALL"
        }
        category = "Coding"
    }

    $name = "local-plugins"
    $interface = [ordered]@{ displayName = "Local Plugins" }
    $plugins = @()

    if (Test-Path $marketplacePath) {
        try {
            $existing = Get-Content $marketplacePath -Raw | ConvertFrom-Json
            if ($existing.name) { $name = $existing.name }
            if ($existing.interface) { $interface = $existing.interface }
            if ($existing.plugins) {
                $plugins = @($existing.plugins | Where-Object { $_.name -ne $PluginName })
            }
        } catch {
            $backup = "$marketplacePath.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
            Copy-Item $marketplacePath $backup -Force
            Write-Warn "Invalid marketplace.json backed up to $backup"
        }
    }

    $marketplace = [ordered]@{
        name = $name
        interface = $interface
        plugins = @($plugins + $entry)
    }
    Set-Content $marketplacePath ($marketplace | ConvertTo-Json -Depth 20) -Encoding UTF8
    Write-OK "marketplace.json registered $PluginName"
}

function Initialize-Homunculus {
    @(
        "instincts\personal",
        "instincts\inherited",
        "evolved\skills",
        "evolved\commands",
        "evolved\agents",
        "projects",
        "skill-signals",
        "skill-evals",
        "skill-changelog"
    ) | ForEach-Object { Ensure-Dir (Join-Path $HomunculusDir $_) }

    $configTarget = Join-Path $HomunculusDir "config.json"
    if (-not (Test-Path $configTarget)) {
        Copy-Item (Join-Path $PluginSource "codex-homunculus-template\config.json") $configTarget -Force
        Write-OK "homunculus config.json"
    }
    $registry = Join-Path $HomunculusDir "projects.json"
    if (-not (Test-Path $registry)) { Set-Content $registry "{}" -Encoding UTF8 }
}

function Install-User {
    Write-Section "Installing Codex plugin -> $PluginTarget"
    Test-Node
    Build-Plugin
    Ensure-Dir $UserPluginsRoot

    if (Test-Path $PluginTarget) {
        $backup = "$PluginTarget.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
        Move-Item $PluginTarget $backup -Force
        Write-Warn "Existing plugin backed up to $backup"
    }
    Copy-Item $PluginSource $UserPluginsRoot -Recurse -Force
    Write-OK "plugin copied"

    Update-Marketplace
    Initialize-Homunculus
}

function Install-Project {
    $root = (Get-Location).Path
    $codexDir = Join-Path $root ".codex"
    Write-Section "Installing Codex project templates -> $codexDir"

    @("commands", "rules", "plans") | ForEach-Object { Ensure-Dir (Join-Path $codexDir $_) }
    Ensure-Dir (Join-Path $root "docs\solutions")

    $agentsTarget = Join-Path $root "AGENTS.md"
    Copy-CodexText (Join-Path $ScriptDir "project-level\CLAUDE.md") $agentsTarget -NoOverwrite

    $rulesSource = Join-Path $ScriptDir "project-level\.claude\rules"
    if (Test-Path $rulesSource) {
        Get-ChildItem $rulesSource -Filter "*.md" | ForEach-Object {
            Copy-CodexText $_.FullName (Join-Path $codexDir "rules\$($_.Name)") -NoOverwrite
        }
        Write-OK "rules copied"
    }

    $commandsSource = Join-Path $ScriptDir "project-level\.claude\commands"
    if (Test-Path $commandsSource) {
        Get-ChildItem $commandsSource -Filter "*.md" | ForEach-Object {
            Copy-CodexText $_.FullName (Join-Path $codexDir "commands\$($_.Name)")
        }
        Write-OK "project commands copied"
    }

    Write-OK "project directories ready"
}

function Import-ClaudeHomunculus {
    $source = Join-Path $HomeDir ".claude\homunculus"
    if (-not (Test-Path $source)) {
        Write-Warn "No Claude homunculus found at $source"
        return
    }
    if (Test-Path $HomunculusDir) {
        Write-Warn "$HomunculusDir already exists, import skipped"
        return
    }
    Ensure-Dir $CodexHome
    Copy-Item $source $HomunculusDir -Recurse -Force
    Write-OK "imported Claude homunculus"
}

if ($Help) {
    Show-Help
} else {
    if ($ImportClaude) { Import-ClaudeHomunculus }
    if ($All) {
        Install-User
        Install-Project
    } elseif ($User) {
        Install-User
    } elseif ($Project) {
        Install-Project
    } else {
        Show-Help
    }
}
