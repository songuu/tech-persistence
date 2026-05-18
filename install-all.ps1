#!/usr/bin/env pwsh
# Unified Windows installer for Tech Persistence.
#
# This is intentionally a thin orchestration layer. The Claude legacy,
# Codex, and Claude plugin installers keep their own ownership boundaries;
# this script only selects and runs them consistently.

param(
    [switch]$All,
    [switch]$Legacy,
    [switch]$Codex,
    [switch]$Plugin,
    [switch]$SkipLegacy,
    [switch]$SkipCodex,
    [switch]$SkipPlugin,
    [switch]$ImportClaude,
    [string]$SharedHomunculus,
    [switch]$AllowOutsideHome,
    [switch]$DryRun,
    [switch]$ContinueOnError,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

function Show-Help {
    Write-Host @"
Usage:
  powershell -ExecutionPolicy Bypass -File .\install-all.ps1 -All

Targets:
  -All           Run all supported Windows installers.
  -Legacy        Run .\install.ps1 -All only.
  -Codex         Run .\install-codex.ps1 -All only.
  -Plugin        Run .\install-plugin.ps1 -All only.

Filters:
  -SkipLegacy    Skip the legacy Claude Code installer.
  -SkipCodex     Skip the Codex installer.
  -SkipPlugin    Skip the Claude Code plugin installer.

Options:
  -ImportClaude          Forward to install-codex.ps1.
  -SharedHomunculus <p>  Forward to install.ps1 and install-codex.ps1.
  -AllowOutsideHome      Forward to shared-homunculus installers.
  -DryRun                Print child commands without executing them.
  -ContinueOnError       Run remaining installers after a failure, then exit non-zero.
  -Help                  Show this help.

If no target switch is provided, this script defaults to -All.
"@
}

function Get-PowerShellExecutable {
    $windowsPowerShell = Get-Command powershell -ErrorAction SilentlyContinue
    if ($windowsPowerShell) { return $windowsPowerShell.Source }

    $powerShellCore = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($powerShellCore) { return $powerShellCore.Source }

    throw 'PowerShell executable not found. Install Windows PowerShell or PowerShell Core.'
}

function Format-DisplayArg {
    param([string]$Arg)

    if ($null -eq $Arg -or $Arg -eq '') { return "''" }
    if ($Arg -match "[\s'`"$&|<>;()]") {
        return "'" + ($Arg -replace "'", "''") + "'"
    }
    return $Arg
}

function Invoke-Installer {
    param(
        [string]$Name,
        [string]$ScriptName,
        [string[]]$Arguments
    )

    $scriptPath = Join-Path $ScriptDir $ScriptName
    if (-not (Test-Path -LiteralPath $scriptPath)) {
        throw "Missing installer: $scriptPath"
    }

    $displayArgs = @()
    foreach ($argument in $Arguments) {
        $displayArgs += Format-DisplayArg $argument
    }

    $display = "powershell -ExecutionPolicy Bypass -File .\$ScriptName"
    if ($displayArgs.Count -gt 0) {
        $display += ' ' + ($displayArgs -join ' ')
    }

    Write-Host ''
    Write-Host ">>> $Name"
    Write-Host "    $display"

    if ($DryRun) { return $true }

    & $script:PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $scriptPath @Arguments
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }

    if ($exitCode -ne 0) {
        Write-Warning "$Name failed with exit code $exitCode."
        return $false
    }

    Write-Host ">>> $Name completed"
    return $true
}

if ($Help) {
    Show-Help
    exit 0
}

$hasExplicitTarget = $Legacy -or $Codex -or $Plugin
$runAll = $All -or (-not $hasExplicitTarget)

$runLegacy = $runAll -or $Legacy
$runCodex = $runAll -or $Codex
$runPlugin = $runAll -or $Plugin

if ($SkipLegacy) { $runLegacy = $false }
if ($SkipCodex) { $runCodex = $false }
if ($SkipPlugin) { $runPlugin = $false }

if (-not ($runLegacy -or $runCodex -or $runPlugin)) {
    Write-Error 'No installers selected. Remove skip flags or select at least one target.'
    exit 1
}

$script:PowerShellExe = Get-PowerShellExecutable

$sharedInstallerArgs = @('-All')
if ($SharedHomunculus) {
    $sharedInstallerArgs += @('-SharedHomunculus', $SharedHomunculus)
}
if ($AllowOutsideHome) {
    $sharedInstallerArgs += '-AllowOutsideHome'
}

$codexInstallerArgs = @($sharedInstallerArgs)
if ($ImportClaude) {
    $codexInstallerArgs += '-ImportClaude'
}

$pluginInstallerArgs = @('-All')

$failures = @()

if ($runLegacy) {
    if (-not (Invoke-Installer 'Claude Code legacy install' 'install.ps1' $sharedInstallerArgs)) {
        $failures += 'install.ps1'
        if (-not $ContinueOnError) { exit 1 }
    }
}

if ($runCodex) {
    if (-not (Invoke-Installer 'Codex install' 'install-codex.ps1' $codexInstallerArgs)) {
        $failures += 'install-codex.ps1'
        if (-not $ContinueOnError) { exit 1 }
    }
}

if ($runPlugin) {
    if (-not (Invoke-Installer 'Claude Code plugin install' 'install-plugin.ps1' $pluginInstallerArgs)) {
        $failures += 'install-plugin.ps1'
        if (-not $ContinueOnError) { exit 1 }
    }
}

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Error ("Install finished with failures: " + ($failures -join ', '))
    exit 1
}

if ($DryRun) {
    Write-Host 'Dry run completed. No installers were executed.'
} else {
    Write-Host 'All selected installers completed.'
}
