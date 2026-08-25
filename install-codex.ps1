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
    [switch]$Obsidian,
    [string]$VaultPath,
    [string]$SharedHomunculus,
    [switch]$AllowOutsideHome,
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
$DoctorScript = Join-Path $ScriptDir "scripts\codex-runtime-doctor.js"
$UserInstallTransactionScript = Join-Path $ScriptDir "scripts\codex-user-install-transaction.js"
$MarketplaceUpdateScript = Join-Path $ScriptDir "scripts\update-codex-marketplace.js"
$TextAssetInstallScript = Join-Path $ScriptDir "scripts\install-codex-text-asset.js"
$JsonAssetInstallScript = Join-Path $ScriptDir "scripts\install-codex-json-asset.js"
$CodexAgentsInstallScript = Join-Path $ScriptDir "scripts\install-codex-agents.js"

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
  powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -All -SharedHomunculus "C:\Users\you\Documents\TechPersistence"
  powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -Obsidian [-VaultPath <path>]

Options:
  -User          Install one canonical Codex plugin owner and user templates.
  -Project       Create project templates; use a managed skill fallback only without a plugin owner.
  -All           Run -User and -Project.
  -ImportClaude  Copy ~/.claude/homunculus to ~/.codex/homunculus when the Codex target does not exist.
  -Obsidian      Initialize the Codex homunculus vault (default ~/.codex/homunculus) for Obsidian.
  -VaultPath <path>
                 Override the vault path initialized by -Obsidian.
  -SharedHomunculus <path>
                 Configure Claude Code and Codex to use one shared homunculus/Obsidian vault.
  -AllowOutsideHome
                 Allow -SharedHomunculus outside the user home directory.
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

function Get-DirectoryFingerprint($path, [string[]]$ExcludeTopLevel = @()) {
    if (-not (Test-Path $path)) { return "" }
    $root = (Resolve-Path $path).Path
    $items = Get-ChildItem -LiteralPath $root -Recurse -File -Force | Sort-Object FullName
    $parts = @()
    foreach ($item in $items) {
        $relative = $item.FullName.Substring($root.Length).TrimStart('\','/') -replace '\\','/'
        $topLevel = ($relative -split '/')[0]
        if ($ExcludeTopLevel -contains $topLevel) { continue }
        $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
        $parts += "$relative=$hash"
    }
    return ($parts -join "`n")
}

function Test-SameDirectoryContent($left, $right, [string[]]$ExcludeTopLevel = @()) {
    if (-not (Test-Path $left) -or -not (Test-Path $right)) { return $false }
    return (Get-DirectoryFingerprint $left $ExcludeTopLevel) -eq (Get-DirectoryFingerprint $right $ExcludeTopLevel)
}

function Test-SameCodexPluginBundle($left, $right) {
    if (Test-Path (Join-Path $right "commands")) { return $false }
    return Test-SameDirectoryContent $left $right @("commands")
}

function Resolve-UserPath($path) {
    if (-not $path) { return $path }
    if ($path -eq "~") { return $HomeDir }
    if ($path.StartsWith("~/") -or $path.StartsWith("~\")) {
        return [System.IO.Path]::GetFullPath((Join-Path $HomeDir $path.Substring(2)))
    }
    return [System.IO.Path]::GetFullPath($path)
}

function Configure-SharedHomunculus {
    if (-not $SharedHomunculus) { return }
    Test-Node
    $configureScript = Join-Path $ScriptDir "scripts\configure-shared-homunculus.js"
    if (-not (Test-Path $configureScript)) { throw "Missing shared homunculus configurator: $configureScript" }

    $args = @($configureScript, "--path", $SharedHomunculus, "--force")
    if ($AllowOutsideHome) { $args += "--allow-outside-home" }
    & node @args
    if ($LASTEXITCODE -ne 0) { throw "Shared homunculus configuration failed" }
    $script:HomunculusDir = Resolve-UserPath $SharedHomunculus
}

function Copy-CodexText($source, $target, [switch]$NoOverwrite, [switch]$BackupExisting, [switch]$RepairGenerated) {
    if (-not (Test-Path -LiteralPath $TextAssetInstallScript)) {
        throw "Missing Codex text asset installer: $TextAssetInstallScript"
    }
    $targetDir = Split-Path -Parent $target
    Ensure-Dir $targetDir
    $mode = if ($NoOverwrite) {
        if ($RepairGenerated) { "no-overwrite" } else { "no-overwrite-strict" }
    } elseif ($BackupExisting) {
        "backup"
    } else {
        "overwrite"
    }
    $args = @(
        $TextAssetInstallScript,
        "--allowed-root", $targetDir,
        "--source", $source,
        "--target", $target,
        "--mode", $mode
    )
    $output = @(& node @args 2>&1)
    $helperExit = $LASTEXITCODE
    if ($helperExit -ne 0) {
        throw "Codex text asset compare-and-swap failed for ${target}: $($output -join ' ')"
    }
    if (-not $output) { throw "Codex text asset installer returned no result for $target" }
    try {
        $result = $output[-1].ToString() | ConvertFrom-Json
    } catch {
        throw "Codex text asset installer returned invalid JSON for ${target}: $($output -join ' ')"
    }
    if ($result.status -eq "skipped") {
        Write-Warn "$(Split-Path -Leaf $target) exists, skip"
    } elseif ($result.status -eq "repaired") {
        Write-Warn "$(Split-Path -Leaf $target) looked generated/broken, backed up to $($result.backupPath) and repaired"
    }
}
function Copy-CodexCommandDir($sourceDir, $targetDir, [string[]]$ExcludeNames = @()) {
    if (-not (Test-Path $sourceDir)) { return 0 }
    Ensure-Dir $targetDir
    $excluded = @{}
    foreach ($name in $ExcludeNames) { $excluded[$name] = $true }
    $count = 0
    Get-ChildItem $sourceDir -Filter "*.md" | ForEach-Object {
        if (-not $excluded.ContainsKey($_.Name)) {
            Copy-CodexText $_.FullName (Join-Path $targetDir $_.Name) -BackupExisting
            $count++
        }
    }
    return $count
}

function Copy-CodexRuleDir($sourceDir, $targetDir) {
    if (-not (Test-Path $sourceDir)) { return 0 }
    Ensure-Dir $targetDir
    $count = 0
    Get-ChildItem $sourceDir -Filter "*.md" | ForEach-Object {
        Copy-CodexText $_.FullName (Join-Path $targetDir $_.Name) -NoOverwrite -RepairGenerated
        $count++
    }
    return $count
}

function Install-CodexAgentsFile($kind, $allowedRoot, $target, $template, $legacySource) {
    if (-not (Test-Path $CodexAgentsInstallScript)) {
        throw "Missing Codex AGENTS installer: $CodexAgentsInstallScript"
    }

    $output = @(& node $CodexAgentsInstallScript `
        --kind $kind `
        --allowed-root $allowedRoot `
        --target $target `
        --template $template `
        --legacy-source $legacySource 2>&1)
    $helperExit = $LASTEXITCODE
    if ($helperExit -ne 0 -and $helperExit -ne 2) {
        throw "Codex AGENTS install failed with exit $helperExit for ${target}: $($output -join ' ')"
    }

    $jsonLine = $output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
    if (-not $jsonLine) { throw "Codex AGENTS installer returned no JSON result for $target" }
    try {
        $result = $jsonLine | ConvertFrom-Json
    } catch {
        throw "Codex AGENTS installer returned invalid JSON for ${target}: $($_.Exception.Message)"
    }
    if (-not $result.status) { throw "Codex AGENTS installer returned no status for $target" }
    if ($result.backupPath) { Write-Warn "Previous AGENTS.md retained at $($result.backupPath)" }
    if ($helperExit -eq 2) {
        $reason = if ($result.reason) { ": $($result.reason)" } else { "" }
        Write-Warn "AGENTS.md $($result.status); Codex-native optimization was not applied$reason"
    } else {
        Write-OK "AGENTS.md $($result.status)"
    }
}

function Install-CodexUserAssets {
    Write-Section "Installing Codex user assets -> $CodexHome"

    Ensure-Dir (Join-Path $CodexHome "commands")
    Ensure-Dir (Join-Path $CodexHome "rules")

    Install-CodexAgentsFile `
        "user" `
        $CodexHome `
        (Join-Path $CodexHome "AGENTS.md") `
        (Join-Path $ScriptDir "codex-native\agents\user.md") `
        (Join-Path $ScriptDir "user-level\CLAUDE.md")

    $nativeCommandDir = Join-Path $ScriptDir "codex-native\commands"
    $nativeCommandNames = @(Get-ChildItem $nativeCommandDir -Filter "*.md" | ForEach-Object { $_.Name })
    $userCommandCount = Copy-CodexCommandDir (Join-Path $ScriptDir "user-level\commands") (Join-Path $CodexHome "commands") $nativeCommandNames
    $nativeCommandCount = Copy-CodexCommandDir $nativeCommandDir (Join-Path $CodexHome "commands")
    $commandCount = $userCommandCount + $nativeCommandCount
    $ruleCount = Copy-CodexRuleDir (Join-Path $ScriptDir "user-level\rules") (Join-Path $CodexHome "rules")

    Write-OK "$commandCount user commands copied"
    Write-OK "$ruleCount user rules copied"
    Write-OK "skills and hooks are owned by the canonical plugin"
}

function Build-Plugin {
    $builder = Join-Path $PluginSource "scripts\build-codex-plugin.js"
    if (-not (Test-Path $builder)) { throw "Missing builder: $builder" }
    & node $builder
    if ($LASTEXITCODE -ne 0) { throw "Codex plugin build failed" }
}

function Invoke-CodexUserInstallTransaction {
    param(
        [Parameter(Mandatory = $true)][string]$Action,
        [string]$ManifestPath,
        [string]$Phase,
        [string]$Reason,
        [string]$ClaimedPath
    )
    if (-not (Test-Path $UserInstallTransactionScript)) {
        throw "Missing Codex user-install transaction helper: $UserInstallTransactionScript"
    }

    $arguments = @($UserInstallTransactionScript, $Action)
    if ($Action -eq "prepare") {
        $arguments += @(
            "--plugin-target", $PluginTarget,
            "--plugin-source", $PluginSource,
            "--marketplace-path", (Join-Path $AgentsPluginsDir "marketplace.json"),
            "--marketplace-root", $HomeDir,
            "--marketplace-name", "local-plugins",
            "--canonical-owner", "$PluginName@local-plugins",
            "--codex-home", $CodexHome,
            "--owner-pid", $PID
        )
    } else {
        if (-not $ManifestPath) { throw "Transaction action $Action requires a manifest path" }
        $arguments += @("--manifest", $ManifestPath)
        if ($Phase) { $arguments += @("--phase", $Phase) }
        if ($Reason) { $arguments += @("--reason", $Reason) }
        if ($ClaimedPath) { $arguments += @("--claimed-path", $ClaimedPath) }
    }

    $output = @(& node @arguments 2>&1)
    $status = $LASTEXITCODE
    if ($status -ne 0) {
        throw "Codex user-install transaction $Action failed: $($output -join ' ')"
    }
    $result = $output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ } | Select-Object -Last 1
    if (-not $result) { throw "Codex user-install transaction $Action returned no manifest path" }
    return $result
}

function Get-CodexUserInstallTransactionStatus([string]$ManifestPath) {
    $result = [ordered]@{
        State = "missing"
        Disposition = $null
        LockReleaseError = $null
    }
    if (-not $ManifestPath -or -not (Test-Path -LiteralPath $ManifestPath)) {
        return [pscustomobject]$result
    }
    try {
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($manifest.state) { $result.State = $manifest.state.ToString() }
        if ($manifest.terminalDisposition) { $result.Disposition = $manifest.terminalDisposition.ToString() }
        if ($manifest.lockReleaseError) { $result.LockReleaseError = $manifest.lockReleaseError.ToString() }
    } catch { }
    if ($result.State -eq "missing") { $result.State = "unknown" }
    return [pscustomobject]$result
}

function Invoke-CodexUserInstallCleanup([string]$ManifestPath, [string]$Reason) {
    $status = Get-CodexUserInstallTransactionStatus $ManifestPath
    $result = [ordered]@{
        State = $status.State
        Disposition = $status.Disposition
        LockReleaseError = $status.LockReleaseError
        Error = $null
    }
    if ($result.State -in @("committed", "rolled-back", "recovery-required")) {
        return [pscustomobject]$result
    }
    try {
        Invoke-CodexUserInstallTransaction -Action "rollback" -ManifestPath $ManifestPath -Reason $Reason | Out-Null
    } catch {
        $result.Error = $_.Exception.Message
    }
    $status = Get-CodexUserInstallTransactionStatus $ManifestPath
    $result.State = $status.State
    $result.Disposition = $status.Disposition
    $result.LockReleaseError = $status.LockReleaseError
    return [pscustomobject]$result
}

function Invoke-InstallFailureInjection([string]$Step) {
    if ($env:CODEX_INSTALL_FAIL_AT -and $env:CODEX_INSTALL_FAIL_AT -eq $Step) {
        throw "Injected Codex user-install failure after $Step"
    }
}

function Install-CodexPluginBundle {
    param(
        [Parameter(Mandatory = $true)][string]$TransactionManifest
    )
    Ensure-Dir $UserPluginsRoot
    $targetExisted = Test-Path -LiteralPath $PluginTarget
    $originalTargetFingerprint = if ($targetExisted) { Get-DirectoryFingerprint $PluginTarget } else { "" }
    if ($targetExisted -and (Test-SameCodexPluginBundle $PluginSource $PluginTarget)) {
        Write-OK "plugin already up to date"
        return
    }

    $stage = Join-Path $UserPluginsRoot (".$PluginName.stage." + [guid]::NewGuid().ToString("N"))
    $activationId = "$PID.$([guid]::NewGuid().ToString('N'))"
    $backup = "$PluginTarget.bak.$(Get-Date -Format 'yyyyMMddHHmmss').$activationId"
    $backupCreated = $false
    $claimedBytesVerified = $false

    try {
        Copy-Item -LiteralPath $PluginSource -Destination $stage -Recurse -Force
        $legacyCommands = Join-Path $stage "commands"
        if (Test-Path $legacyCommands) {
            Remove-Item -LiteralPath $legacyCommands -Recurse -Force
        }
        if (-not (Test-SameCodexPluginBundle $PluginSource $stage)) {
            throw "Staged plugin fingerprint mismatch"
        }

        Invoke-CodexUserInstallTransaction `
            -Action "activation-gate" `
            -ManifestPath $TransactionManifest `
            -Phase "before-claim" | Out-Null

        if ($targetExisted) {
            if (-not (Test-Path -LiteralPath $PluginTarget)) {
                throw "Canonical plugin target disappeared after the before-claim activation gate"
            }
            if ((Get-DirectoryFingerprint $PluginTarget) -ne $originalTargetFingerprint) {
                throw "Canonical plugin target changed after the before-claim activation gate"
            }
            if (Test-Path -LiteralPath $backup) {
                throw "Exclusive plugin backup destination is already occupied"
            }
            [System.IO.Directory]::Move($PluginTarget, $backup)
            $backupCreated = $true
            if (Test-Path -LiteralPath $PluginTarget) {
                throw "Canonical plugin target still exists after it was claimed"
            }
            if (-not (Test-Path -LiteralPath $backup)) {
                throw "Claimed plugin bytes are missing from the activation backup"
            }
            if ((Get-DirectoryFingerprint $backup) -ne $originalTargetFingerprint) {
                throw "Claimed plugin backup fingerprint differs from the original target"
            }
            Invoke-CodexUserInstallTransaction `
                -Action "activation-gate" `
                -ManifestPath $TransactionManifest `
                -Phase "claimed" `
                -ClaimedPath $backup | Out-Null
            $claimedBytesVerified = $true
            Write-Warn "Existing plugin backed up to $backup"
        } else {
            if (Test-Path -LiteralPath $PluginTarget) {
                throw "Canonical plugin target appeared after the before-claim activation gate"
            }
            Invoke-CodexUserInstallTransaction `
                -Action "activation-gate" `
                -ManifestPath $TransactionManifest `
                -Phase "claimed" | Out-Null
        }
        if (Test-Path -LiteralPath $PluginTarget) {
            throw "Canonical plugin target appeared before staged plugin publication"
        }
        [System.IO.Directory]::Move($stage, $PluginTarget)
        if (-not (Test-SameCodexPluginBundle $PluginSource $PluginTarget)) {
            throw "Activated plugin fingerprint mismatch"
        }
        Write-OK "plugin activated from verified stage"
    } catch {
        if ($backupCreated -and (Test-Path $backup)) {
            if ($claimedBytesVerified -and -not (Test-Path -LiteralPath $PluginTarget)) {
                try {
                    if ((Get-DirectoryFingerprint $backup) -ne $originalTargetFingerprint) {
                        throw "Preserved plugin backup changed before restoration"
                    }
                    [System.IO.Directory]::Move($backup, $PluginTarget)
                    if ((Get-DirectoryFingerprint $PluginTarget) -ne $originalTargetFingerprint) {
                        throw "Restored plugin fingerprint differs from the claimed bytes"
                    }
                    Write-Warn "Previous plugin restored after activation failure"
                } catch {
                    Write-Warn "Previous plugin remains preserved at $backup because restoration failed"
                }
            } else {
                Write-Warn "Previous plugin remains preserved at $backup because the claim is unverified or the canonical target is occupied"
            }
        }
        throw
    } finally {
        if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
}

function Update-Marketplace {
    param(
        [string]$MarketplaceDir = $AgentsPluginsDir,
        [string]$MarketplaceName = "local-plugins",
        [string]$MarketplaceDisplayName = "Local Plugins",
        [Parameter(Mandatory = $true)][string]$TransactionManifest
    )

    if (-not (Test-Path -LiteralPath $MarketplaceUpdateScript)) {
        throw "Missing lossless marketplace updater: $MarketplaceUpdateScript"
    }
    Ensure-Dir $MarketplaceDir
    $marketplacePath = Join-Path $MarketplaceDir "marketplace.json"
    $output = @(& node $MarketplaceUpdateScript `
        --path $marketplacePath `
        --name $MarketplaceName `
        --display-name $MarketplaceDisplayName `
        --plugin-name $PluginName `
        --manifest $TransactionManifest 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Codex marketplace file update failed: $($output -join ' ')"
    }
    $jsonLine = $output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
    if ($jsonLine) {
        $update = $jsonLine | ConvertFrom-Json
        if ($update.backupPath) { Write-Warn "Invalid marketplace.json backed up to $($update.backupPath)" }
    }
    Write-OK "marketplace.json registered $PluginName"
}

function Register-CodexMarketplace {
    try {
        & codex plugin marketplace add $HomeDir --json | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Codex marketplace registration exited $LASTEXITCODE" }
        Write-OK "codex marketplace registered: $HomeDir"
    } catch {
        throw "Codex marketplace registration failed: $($_.Exception.Message)"
    }
}

function Refresh-CodexPluginCache {
    & codex plugin add "$PluginName@local-plugins" --json | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Codex canonical plugin cache refresh failed"
    }
    Write-OK "codex plugin cache refreshed from canonical marketplace"
}

function Repair-CodexRuntime {
    if (-not (Test-Path $DoctorScript)) { throw "Missing Codex runtime doctor: $DoctorScript" }

    Write-Section "Inspecting Codex runtime ownership (read-only)"
    & node $DoctorScript --reference-plugin-root $PluginTarget
    if ($LASTEXITCODE -eq 0) {
        Write-OK "runtime ownership already healthy"
    } else {
        Write-Warn "runtime ownership needs a safe repair; dry-run completed"
    }

    Write-Section "Enforcing one canonical Codex runtime owner"
    & node $DoctorScript --fix --install-canonical --reference-plugin-root $PluginTarget
    if ($LASTEXITCODE -ne 0) { throw "Codex runtime owner repair failed" }
    Write-OK "canonical owner: tech-persistence@local-plugins"
}

function Get-CodexPluginOwnerStatus {
    if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
        return [pscustomobject]@{ Available = $false; OwnerCount = 0; PluginIds = @() }
    }
    if (-not (Test-Path $DoctorScript)) { throw "Missing Codex runtime doctor: $DoctorScript" }

    $output = @(& node $DoctorScript --plugin-owner-status --json 2>&1)
    $status = $LASTEXITCODE
    $jsonLine = $output | ForEach-Object { $_.ToString() } | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1
    if (-not $jsonLine) { throw "Codex owner probe returned no JSON: $($output -join ' ')" }
    try {
        $payload = $jsonLine | ConvertFrom-Json
    } catch {
        throw "Codex owner probe returned invalid JSON: $jsonLine"
    }
    if ($status -notin @(0, 2, 3)) { throw "Codex owner probe failed with exit code $status" }
    return [pscustomobject]@{
        Available = $true
        OwnerCount = [int]$payload.ownerCount
        PluginIds = @($payload.pluginIds)
    }
}

function Assert-CodexRuntimeSingleOwner($referencePluginRoot) {
    & node $DoctorScript --reference-plugin-root $referencePluginRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Codex runtime is not single-owner healthy. Run the user installer or runtime doctor first."
    }
    Write-OK "runtime doctor verified ownerCount=1"
}

function Install-ManagedProjectFallback($codexDir) {
    $skillsSource = Join-Path $PluginSource "codex-skills"
    $fallbackInstaller = Join-Path $ScriptDir "scripts\install-managed-project-fallback.js"
    if (-not (Test-Path $skillsSource)) { throw "Missing built Codex skills: $skillsSource" }
    if (-not (Test-Path $fallbackInstaller)) { throw "Missing managed fallback installer: $fallbackInstaller" }

    & node $fallbackInstaller --source $skillsSource --codex-dir $codexDir --user-codex-home $CodexHome
    if ($LASTEXITCODE -ne 0) { throw "Managed project fallback installation failed" }
    Write-OK "managed project fallback installed with SHA256 owner manifest"
}

function Install-HomunculusJsonAsset {
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [string]$Source,
        [string]$DefaultJson
    )
    if (-not (Test-Path -LiteralPath $JsonAssetInstallScript)) {
        throw "Missing atomic JSON asset installer: $JsonAssetInstallScript"
    }
    $arguments = @($JsonAssetInstallScript, "--target", $Target)
    if ($Source) {
        $arguments += @("--source", $Source)
    } elseif ($PSBoundParameters.ContainsKey("DefaultJson")) {
        $arguments += @("--default-json", $DefaultJson)
    } else {
        throw "JSON asset install requires Source or DefaultJson"
    }
    $output = @(& node @arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Atomic JSON asset install failed for ${Target}: $($output -join ' ')"
    }
    $jsonLine = $output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
    if (-not $jsonLine) { throw "Atomic JSON asset install returned no result for $Target" }
    $result = $jsonLine | ConvertFrom-Json
    if ($result.backupPath) { Write-Warn "Invalid JSON asset backed up to $($result.backupPath)" }
    Write-OK "homunculus $([System.IO.Path]::GetFileName($Target)) $($result.status)"
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
    Install-HomunculusJsonAsset `
        -Target $configTarget `
        -Source (Join-Path $PluginSource "codex-homunculus-template\config.json")
    $registry = Join-Path $HomunculusDir "projects.json"
    Install-HomunculusJsonAsset -Target $registry -DefaultJson "{}"

    Update-ObsidianIfExists
}

# Refresh existing vault config when present. Do not create a new vault.
function Update-ObsidianIfExists {
    if (-not (Test-Path (Join-Path $HomunculusDir ".obsidian"))) { return }
    $initScript = Join-Path $ScriptDir "scripts\init-obsidian-vault.js"
    if (-not (Test-Path $initScript)) { return }
    try {
        & node $initScript --vault-path $HomunculusDir *> $null
        if ($LASTEXITCODE -eq 0) { Write-OK "Obsidian vault config refreshed" }
    } catch { }
}

function Install-User {
    Write-Section "Installing Codex plugin -> $PluginTarget"
    Test-Node
    Build-Plugin
    $transactionManifest = $null
    $transactionCompleted = $false
    $installError = $null
    $cleanup = $null
    try {
        $transactionManifest = Invoke-CodexUserInstallTransaction -Action "prepare"
        Install-CodexPluginBundle -TransactionManifest $transactionManifest
        Invoke-CodexUserInstallTransaction -Action "activated" -ManifestPath $transactionManifest | Out-Null
        Invoke-InstallFailureInjection "target"

        Update-Marketplace $AgentsPluginsDir "local-plugins" "Local Plugins" $transactionManifest
        Invoke-CodexUserInstallTransaction -Action "checkpoint" -ManifestPath $transactionManifest -Phase "marketplace-file" | Out-Null
        Register-CodexMarketplace
        Invoke-CodexUserInstallTransaction -Action "checkpoint" -ManifestPath $transactionManifest -Phase "marketplace" | Out-Null
        Invoke-InstallFailureInjection "marketplace"

        Refresh-CodexPluginCache
        Invoke-CodexUserInstallTransaction -Action "checkpoint" -ManifestPath $transactionManifest -Phase "cache" | Out-Null
        Invoke-InstallFailureInjection "cache"

        Repair-CodexRuntime
        Invoke-CodexUserInstallTransaction -Action "checkpoint" -ManifestPath $transactionManifest -Phase "doctor" | Out-Null
        Invoke-InstallFailureInjection "doctor"
        Invoke-CodexUserInstallTransaction -Action "commit" -ManifestPath $transactionManifest | Out-Null
        $transactionCompleted = $true
    } catch {
        $installError = $_.Exception.Message
    } finally {
        if ($transactionManifest -and -not $transactionCompleted) {
            $cleanupReason = if ($installError) {
                $installError
            } else {
                "PowerShell pipeline stopped during an active Codex user install"
            }
            $cleanup = Invoke-CodexUserInstallCleanup $transactionManifest $cleanupReason
            if ($cleanup.State -eq "committed") { $transactionCompleted = $true }
        }
    }

    if ($installError) {
        if (-not $transactionManifest) {
            throw "Codex user install failed before activation; no installed owner or plugin target was changed: $installError"
        }
        if ($cleanup.State -eq "committed") {
            $lockDetail = if ($cleanup.LockReleaseError) { $cleanup.LockReleaseError } else { $installError }
            throw "Codex plugin transaction committed, but finalization failed and no rollback was attempted: $lockDetail. The active transaction lock may remain; rerun -User to retry lock cleanup. Evidence: $transactionManifest"
        }
        if ($cleanup.State -eq "rolled-back" -and ($cleanup.LockReleaseError -or $cleanup.Error)) {
            $lockDetail = if ($cleanup.LockReleaseError) { $cleanup.LockReleaseError } else { $cleanup.Error }
            throw "Codex user install failed and rollback completed, but transaction lock release could not be confirmed: $lockDetail. Evidence: $transactionManifest"
        }
        if ($cleanup.State -eq "rolled-back") {
            Write-Warn "User install failed; plugin, marketplace, cache, and owner state were restored"
            throw "Codex user install failed and was rolled back: $installError"
        }
        if ($cleanup.State -eq "recovery-required") {
            $lockStatus = if ($cleanup.LockReleaseError) {
                "the active transaction lock was not released: $($cleanup.LockReleaseError)"
            } elseif ($cleanup.Error) {
                "transaction lock release could not be confirmed: $($cleanup.Error)"
            } else {
                "the transaction lock was released"
            }
            throw "Codex user install failed after the irreversible CLI commit point: $installError. Installer-owned state was preserved and $lockStatus; rerun -User to finish recovery. Evidence: $transactionManifest"
        }
        throw "Codex user install failed: $installError. Compensation also failed closed; evidence: $transactionManifest. $($cleanup.Error)"
    }
    if (-not $transactionCompleted) {
        $cleanupState = if ($cleanup) { $cleanup.State } else { "unknown" }
        throw "Codex user install stopped before transaction completion; cleanup state=$cleanupState evidence=$transactionManifest"
    }

    Write-OK "verified plugin transaction committed: $transactionManifest"
    try {
        Invoke-InstallFailureInjection "user-assets"
        Initialize-Homunculus
        Install-CodexUserAssets
    } catch {
        throw "Codex plugin transaction committed, but post-commit user assets are incomplete: $($_.Exception.Message). Rerun -User; asset writes are atomic and idempotent. Evidence: $transactionManifest"
    }
    Write-OK "Codex user install complete"
}

function Install-Project {
    $root = (Get-Location).Path
    $codexDir = Join-Path $root ".codex"
    Write-Section "Installing Codex project templates -> $codexDir"
    Test-Node
    Build-Plugin

    @("commands", "rules", "plans") | ForEach-Object { Ensure-Dir (Join-Path $codexDir $_) }
    Ensure-Dir (Join-Path $root "docs\solutions")

    $agentsTarget = Join-Path $root "AGENTS.md"
    Install-CodexAgentsFile `
        "project" `
        $root `
        $agentsTarget `
        (Join-Path $ScriptDir "codex-native\agents\project.md") `
        (Join-Path $ScriptDir "project-level\CLAUDE.md")

    $projectCommandDir = Join-Path $ScriptDir "project-level\.claude\commands"
    $catalogPath = Join-Path $ScriptDir "project-level\profiles\catalog.json"
    if (-not (Test-Path -LiteralPath $catalogPath)) { throw "Missing project standards catalog: $catalogPath" }
    $catalog = Get-Content -LiteralPath $catalogPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $projectCommandNames = @($catalog.shared.commands | ForEach-Object { [System.IO.Path]::GetFileName([string]$_) })
    $nativeCommandDir = Join-Path $ScriptDir "codex-native\commands"
    $nativeCommandNames = @(Get-ChildItem $nativeCommandDir -Filter "*.md" | ForEach-Object { $_.Name })
    $excludedUserCommandNames = @($projectCommandNames + $nativeCommandNames | Select-Object -Unique)
    $userCommands = Copy-CodexCommandDir (Join-Path $ScriptDir "user-level\commands") (Join-Path $codexDir "commands") $excludedUserCommandNames
    $projectCommands = 0 # Catalog-managed commands are installed by project-standards.js below.
    $nativeCommands = Copy-CodexCommandDir $nativeCommandDir (Join-Path $codexDir "commands")
    Write-OK "commands copied ($userCommands user, $nativeCommands native; project commands deferred to standards resolver)"

    Copy-CodexRuleDir (Join-Path $ScriptDir "user-level\rules") (Join-Path $codexDir "rules") | Out-Null
    $rulesSource = Join-Path $ScriptDir "project-level\.claude\rules"
    $projectRules = Copy-CodexRuleDir $rulesSource (Join-Path $codexDir "rules")
    Write-OK "rules copied ($projectRules project)"

    $standardsScript = Join-Path $ScriptDir "scripts\project-standards.js"
    if (-not (Test-Path -LiteralPath $standardsScript)) { throw "Missing project standards installer: $standardsScript" }
    & node $standardsScript --project-root $root --runtime codex --profiles auto
    if ($LASTEXITCODE -ne 0) { throw "Codex project standards installation failed" }
    Write-OK "architecture-aware project standards"

    $ownerStatus = Get-CodexPluginOwnerStatus
    if (-not $ownerStatus.Available) {
        Write-Warn "Codex CLI unavailable; installing a managed project skill fallback"
        Install-ManagedProjectFallback $codexDir
    } elseif ($ownerStatus.OwnerCount -eq 0) {
        Write-Warn "No Codex plugin owner is active; installing a managed project skill fallback"
        Install-ManagedProjectFallback $codexDir
    } elseif ($ownerStatus.OwnerCount -eq 1) {
        Write-OK "one plugin owner is active; project skills and hooks were not copied"
    } else {
        throw "Multiple Codex plugin owners detected: $($ownerStatus.PluginIds -join ', '). Run the runtime doctor before project installation."
    }
    if ($ownerStatus.Available) { Assert-CodexRuntimeSingleOwner $PluginSource }

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

function Install-Obsidian {
    Write-Section "Obsidian Vault integration (Codex)"
    Test-Node
    $initScript = Join-Path $ScriptDir "scripts\init-obsidian-vault.js"
    $targetVaultPath = if ($VaultPath) { $VaultPath } elseif ($SharedHomunculus) { Resolve-UserPath $SharedHomunculus } else { $HomunculusDir }
    if (-not (Test-Path $initScript)) { Write-Warn "scripts/init-obsidian-vault.js not found"; return }
    & node $initScript --vault-path $targetVaultPath
    if ($LASTEXITCODE -ne 0) { throw "Obsidian vault initialization failed" }
    $mcpSnippet = Join-Path $targetVaultPath "_mcp-config-snippet.json"
    if (Test-Path $mcpSnippet) {
        Write-Warn "Merge this MCP config into Codex mcpServers:"
        Get-Content $mcpSnippet -Raw | Write-Host
    }
    Write-OK "Obsidian integration complete: $targetVaultPath"
}

if ($Help) {
    Show-Help
} else {
    Configure-SharedHomunculus
    if ($ImportClaude) { Import-ClaudeHomunculus }
    if ($All) {
        Install-User
        Install-Project
    } elseif ($User) {
        Install-User
    } elseif ($Project) {
        Install-Project
    } elseif ($Obsidian) {
        Install-Obsidian
    } else {
        Show-Help
    }
}
