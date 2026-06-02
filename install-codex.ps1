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
$RepoAgentsPluginsDir = Join-Path $ScriptDir ".agents\plugins"
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
  powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -All -SharedHomunculus "C:\Users\you\Documents\TechPersistence"
  powershell -ExecutionPolicy Bypass -File .\install-codex.ps1 -Obsidian [-VaultPath <path>]

Options:
  -User          Install the Codex plugin to ~/plugins/tech-persistence and register marketplace.json.
  -Project       Create .codex project directories and project templates.
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

function Write-Utf8NoBom($path, $content) {
    $encoding = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($path, $content, $encoding)
}

function Get-BackupRetention {
    if ($env:INSTALL_BAK_RETENTION) {
        $parsed = 0
        if ([int]::TryParse($env:INSTALL_BAK_RETENTION, [ref]$parsed) -and $parsed -ge 0) {
            return $parsed
        }
    }
    return 3
}

function Get-BackupFiles($path) {
    $parent = Split-Path -Parent $path
    $leaf = Split-Path -Leaf $path
    if (-not (Test-Path $parent)) { return @() }
    return @(Get-ChildItem -LiteralPath $parent -Filter "$leaf.bak.*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
}

function Prune-InstallBackups($path) {
    $retention = Get-BackupRetention
    $backups = Get-BackupFiles $path
    if ($backups.Count -gt $retention) {
        $backups | Select-Object -Skip $retention | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-SameTextContent($path, $content) {
    if (-not (Test-Path $path)) { return $false }
    $current = Get-Content $path -Raw -Encoding UTF8
    return $current -eq $content
}

function Get-DirectoryFingerprint($path) {
    if (-not (Test-Path $path)) { return "" }
    $root = (Resolve-Path $path).Path
    $items = Get-ChildItem -LiteralPath $root -Recurse -File -Force | Sort-Object FullName
    $parts = @()
    foreach ($item in $items) {
        $relative = $item.FullName.Substring($root.Length).TrimStart('\','/') -replace '\\','/'
        $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
        $parts += "$relative=$hash"
    }
    return ($parts -join "`n")
}

function Test-SameDirectoryContent($left,$right) {
    if (-not (Test-Path $left) -or -not (Test-Path $right)) { return $false }
    return (Get-DirectoryFingerprint $left) -eq (Get-DirectoryFingerprint $right)
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

function Convert-CodexText($text) {
    $result = $text
    $result = $result -creplace '~\/\.claude\/CLAUDE\.md', '~/.codex/AGENTS.md'
    $result = $result -creplace '~\/\.claude\/homunculus', '~/.codex/homunculus'
    $result = $result -creplace 'CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR'
    $result = $result -creplace 'CLAUDE\.md', 'AGENTS.md'
    $result = $result -creplace '\.claude\/commands', '.codex/commands'
    $result = $result -creplace '\.claude\/skills', '.codex/skills'
    $result = $result -creplace '\.claude\/rules', '.codex/rules'
    $result = $result -creplace '\.claude\/plans', '.codex/plans'
    $result = $result -creplace '\.claude', '.codex'
    $result = $result -creplace 'Claude Code', 'Codex'
    $result = $result -creplace 'Claude', 'Codex'
    return $result
}

function Test-GeneratedCodexTemplateNeedsRepair($path) {
    if (-not (Test-Path $path)) { return $false }
    $content = Get-Content $path -Raw -Encoding UTF8
    return $content -match 'Codex\.md|\.Codex|~\/\.Codex|\u951B|\u9286|\u93CB|\u7EDB|\u7481|\u9350|\u9428|\u6D93\u20AC'
}

function Backup-ExistingFile($path) {
    if (Test-Path $path) {
        Copy-Item -LiteralPath $path -Destination "$path.bak.$(Get-Date -Format 'yyyyMMddHHmmss')" -Force
        Prune-InstallBackups $path
    }
}

function Copy-CodexText($source, $target, [switch]$NoOverwrite, [switch]$BackupExisting, [switch]$RepairGenerated) {
    $content = Get-Content $source -Raw -Encoding UTF8
    $converted = Convert-CodexText $content

    if ($NoOverwrite -and (Test-Path $target)) {
        if ($RepairGenerated -and (Test-GeneratedCodexTemplateNeedsRepair $target)) {
            if (Test-SameTextContent $target $converted) {
                Prune-InstallBackups $target
                return
            }
            Backup-ExistingFile $target
            Write-Warn "$(Split-Path -Leaf $target) looked generated/broken, backed up and repaired"
        } else {
            Prune-InstallBackups $target
            Write-Warn "$(Split-Path -Leaf $target) exists, skip"
            return
        }
    } elseif ($BackupExisting -and (Test-Path $target)) {
        if (Test-SameTextContent $target $converted) {
            Prune-InstallBackups $target
            return
        }
        Backup-ExistingFile $target
    }
    Ensure-Dir (Split-Path -Parent $target)
    Write-Utf8NoBom $target $converted
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

function Copy-CodexSkillDir($sourceDir, $targetDir) {
    if (-not (Test-Path $sourceDir)) { return 0 }
    Ensure-Dir $targetDir
    $count = 0
    Get-ChildItem $sourceDir -Directory | ForEach-Object {
        $skillSource = Join-Path $_.FullName "SKILL.md"
        if (Test-Path $skillSource) {
            $skillTargetDir = Join-Path $targetDir $_.Name
            Ensure-Dir $skillTargetDir
            Get-ChildItem $_.FullName -Force | ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination $skillTargetDir -Recurse -Force
            }
            $count++
        }
    }
    return $count
}

function Install-CodexUserAssets {
    Write-Section "Installing Codex user assets -> $CodexHome"

    Ensure-Dir (Join-Path $CodexHome "commands")
    Ensure-Dir (Join-Path $CodexHome "rules")
    Ensure-Dir (Join-Path $CodexHome "skills")

    Copy-CodexText (Join-Path $ScriptDir "user-level\CLAUDE.md") (Join-Path $CodexHome "AGENTS.md") -NoOverwrite -RepairGenerated

    $commandCount = Copy-CodexCommandDir (Join-Path $ScriptDir "user-level\commands") (Join-Path $CodexHome "commands")
    $ruleCount = Copy-CodexRuleDir (Join-Path $ScriptDir "user-level\rules") (Join-Path $CodexHome "rules")
    $skillCount = Copy-CodexSkillDir (Join-Path $PluginSource "skills") (Join-Path $CodexHome "skills")

    $hooksSource = Join-Path $PluginSource "hooks"
    $hooksTarget = Join-Path $CodexHome "skills\continuous-learning\hooks"
    if (Test-Path $hooksSource) {
        Ensure-Dir $hooksTarget
        Copy-Item (Join-Path $hooksSource "*") $hooksTarget -Recurse -Force
        Write-OK "continuous-learning hooks copied"
    }

    Write-OK "$commandCount user commands copied"
    Write-OK "$ruleCount user rules copied"
    Write-OK "$skillCount user skills copied"
}

function Build-Plugin {
    $builder = Join-Path $PluginSource "scripts\build-codex-plugin.js"
    if (-not (Test-Path $builder)) { throw "Missing builder: $builder" }
    & node $builder
    if ($LASTEXITCODE -ne 0) { throw "Codex plugin build failed" }
}

function Update-Marketplace {
    param(
        [string]$MarketplaceDir = $AgentsPluginsDir,
        [string]$MarketplaceName = "local-plugins",
        [string]$MarketplaceDisplayName = "Local Plugins"
    )

    Ensure-Dir $MarketplaceDir
    $marketplacePath = Join-Path $MarketplaceDir "marketplace.json"
    $entry = [ordered]@{
        name = $PluginName
        source = [ordered]@{
            source = "local"
            path = "./plugins/$PluginName"
        }
        policy = [ordered]@{
            installation = "INSTALLED_BY_DEFAULT"
            authentication = "ON_INSTALL"
        }
        category = "Coding"
    }

    $name = $MarketplaceName
    $interface = [ordered]@{ displayName = $MarketplaceDisplayName }
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
    Write-Utf8NoBom $marketplacePath ($marketplace | ConvertTo-Json -Depth 20)
    Write-OK "marketplace.json registered $PluginName"
}

function Update-Marketplaces {
    Update-Marketplace $AgentsPluginsDir "local-plugins" "Local Plugins"
    Update-Marketplace $RepoAgentsPluginsDir "tech-persistence-local" "Tech Persistence Local"
}

function Register-CodexMarketplace {
    try {
        & codex plugin marketplace add $ScriptDir | Out-Host
        if ($LASTEXITCODE -eq 0) {
            Write-OK "codex marketplace registered: $ScriptDir"
            return
        }
        Write-Warn "codex marketplace registration exited $LASTEXITCODE; run manually: codex plugin marketplace add `"$ScriptDir`""
    } catch {
        Write-Warn "codex marketplace add unavailable; run manually after install: codex plugin marketplace add `"$ScriptDir`""
    }
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
    if (-not (Test-Path $registry)) { Write-Utf8NoBom $registry "{}" }

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
    Ensure-Dir $UserPluginsRoot

    if (Test-Path $PluginTarget) {
        if (Test-SameDirectoryContent $PluginSource $PluginTarget) {
            Prune-InstallBackups $PluginTarget
            Write-OK "plugin already up to date"
        } else {
            $backup = "$PluginTarget.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
            Move-Item -LiteralPath $PluginTarget -Destination $backup -Force
            Prune-InstallBackups $PluginTarget
            Write-Warn "Existing plugin backed up to $backup"
            Copy-Item $PluginSource $UserPluginsRoot -Recurse -Force
            Write-OK "plugin copied"
        }
    } else {
        Copy-Item $PluginSource $UserPluginsRoot -Recurse -Force
        Write-OK "plugin copied"
    }

    Update-Marketplaces
    Register-CodexMarketplace
    Initialize-Homunculus
    Install-CodexUserAssets
}

function Install-Project {
    $root = (Get-Location).Path
    $codexDir = Join-Path $root ".codex"
    Write-Section "Installing Codex project templates -> $codexDir"
    Test-Node
    Build-Plugin

    @("commands", "rules", "plans", "skills") | ForEach-Object { Ensure-Dir (Join-Path $codexDir $_) }
    Ensure-Dir (Join-Path $root "docs\solutions")

    $agentsTarget = Join-Path $root "AGENTS.md"
    Copy-CodexText (Join-Path $ScriptDir "project-level\CLAUDE.md") $agentsTarget -NoOverwrite -RepairGenerated

    $projectCommandDir = Join-Path $ScriptDir "project-level\.claude\commands"
    $projectCommandNames = @()
    if (Test-Path $projectCommandDir) {
        $projectCommandNames = @(Get-ChildItem $projectCommandDir -Filter "*.md" | ForEach-Object { $_.Name })
    }
    $userCommands = Copy-CodexCommandDir (Join-Path $ScriptDir "user-level\commands") (Join-Path $codexDir "commands") $projectCommandNames
    $projectCommands = Copy-CodexCommandDir $projectCommandDir (Join-Path $codexDir "commands")
    Write-OK "commands copied ($userCommands user, $projectCommands project)"

    Copy-CodexRuleDir (Join-Path $ScriptDir "user-level\rules") (Join-Path $codexDir "rules") | Out-Null
    $rulesSource = Join-Path $ScriptDir "project-level\.claude\rules"
    $projectRules = Copy-CodexRuleDir $rulesSource (Join-Path $codexDir "rules")
    Write-OK "rules copied ($projectRules project)"

    $skillCount = Copy-CodexSkillDir (Join-Path $PluginSource "skills") (Join-Path $codexDir "skills")
    Write-OK "$skillCount project skills copied"

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
