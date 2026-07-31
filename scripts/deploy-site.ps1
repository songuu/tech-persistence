#!/usr/bin/env pwsh
# Static-site release entrypoint for https://songuu.top/tech-persistence/.
# Flow: local gates -> build -> archive/upload -> immutable release -> atomic symlink -> verification.

[CmdletBinding()]
param(
  [ValidateSet("aliyun", "volcengine", "tencent", "custom")]
  [string]$Provider = "aliyun",

  [switch]$SkipTests,
  [switch]$SkipBuild,
  [switch]$SkipVerify,
  [switch]$DryRun,
  [switch]$KeepArchive,

  [string]$DeployHost,
  [string]$RemoteRoot,
  [string]$Domain,
  [string]$BasePath,
  [string]$PublicOrigin,
  [string]$BuildOutput = "site/dist",
  [string]$ReleaseId,

  [ValidateRange(1, 50)]
  [int]$BackupRetention = 3,

  [ValidateSet("https", "http")]
  [string]$LoopbackScheme = "https",

  [string[]]$VerifyPaths = @(
    "",
    "catalog/",
    "architecture/"
  )
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Step([string]$Message) {
  Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function Read-Env([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  return $value
}

function First-Value([object[]]$Values) {
  foreach ($value in $Values) {
    if ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value)) {
      return [string]$value
    }
  }
  return $null
}

function Normalize-BasePath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "/" }
  $normalized = $Value.Trim()
  if (-not $normalized.StartsWith("/")) { $normalized = "/$normalized" }
  if (-not $normalized.EndsWith("/")) { $normalized = "$normalized/" }
  if ($normalized -match "[?#]" -or $normalized -match "(^|/)\.\.(/|$)") {
    throw "BasePath must be a clean URL path. Received: $Value"
  }
  if ($normalized -notmatch "^/[A-Za-z0-9._~/-]*/$") {
    throw "BasePath contains unsupported URL characters. Received: $Value"
  }
  return $normalized
}

function Normalize-RemoteRoot([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "RemoteRoot is missing."
  }

  $normalized = $Value.TrimEnd("/")
  if ($normalized -notmatch "^/[A-Za-z0-9._/-]+$") {
    throw "RemoteRoot must be an absolute Linux path without whitespace. Received: $Value"
  }
  if ($normalized -in @("", "/", "/opt", "/srv", "/var") -or $normalized -match "(^|/)\.\.(/|$)") {
    throw "RemoteRoot is too broad or unsafe. Received: $Value"
  }
  return $normalized
}

function Resolve-SiteOutput([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "BuildOutput is missing."
  }

  $candidate = if ([System.IO.Path]::IsPathRooted($Value)) {
    [System.IO.Path]::GetFullPath($Value)
  } else {
    [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $Value))
  }
  $siteRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "site"))
  $sitePrefix = "$siteRoot$([System.IO.Path]::DirectorySeparatorChar)"

  if (-not $candidate.StartsWith($sitePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "BuildOutput must stay under this repository's site directory. Received: $Value"
  }
  return $candidate
}

function Quote-BashValue([string]$Value) {
  if ($Value -match "['`r`n]") {
    throw "Remote argument contains unsupported shell characters: $Value"
  }
  return "'$Value'"
}

function Invoke-Native([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed (exit $LASTEXITCODE): $File $($Arguments -join ' ')"
  }
}

function Write-ConfigLine([string]$Label, [string]$Value) {
  Write-Host ("  {0,-20} {1}" -f $Label, $Value)
}

$providerProfiles = @{
  aliyun = @{
    Label = "Aliyun ECS"
    DeployHost = "root@47.253.230.197"
    RemoteRoot = "/opt/tech-persistence"
    Domain = "songuu.top"
    BasePath = "/tech-persistence/"
  }
  volcengine = @{
    Label = "Volcengine ECS"
    DeployHost = Read-Env "TECH_PERSISTENCE_VOLCENGINE_HOST"
    RemoteRoot = First-Value @(
      (Read-Env "TECH_PERSISTENCE_VOLCENGINE_REMOTE_ROOT"),
      "/opt/tech-persistence"
    )
    Domain = First-Value @(
      (Read-Env "TECH_PERSISTENCE_VOLCENGINE_DOMAIN"),
      "songuu.top"
    )
    BasePath = First-Value @(
      (Read-Env "TECH_PERSISTENCE_VOLCENGINE_BASE_PATH"),
      "/tech-persistence/"
    )
  }
  tencent = @{
    Label = "Tencent Cloud CVM"
    DeployHost = Read-Env "TECH_PERSISTENCE_TENCENT_HOST"
    RemoteRoot = First-Value @(
      (Read-Env "TECH_PERSISTENCE_TENCENT_REMOTE_ROOT"),
      "/opt/tech-persistence"
    )
    Domain = First-Value @(
      (Read-Env "TECH_PERSISTENCE_TENCENT_DOMAIN"),
      "songuu.top"
    )
    BasePath = First-Value @(
      (Read-Env "TECH_PERSISTENCE_TENCENT_BASE_PATH"),
      "/tech-persistence/"
    )
  }
  custom = @{
    Label = "Custom Linux host"
    DeployHost = Read-Env "TECH_PERSISTENCE_DEPLOY_HOST"
    RemoteRoot = First-Value @(
      (Read-Env "TECH_PERSISTENCE_REMOTE_ROOT"),
      "/opt/tech-persistence"
    )
    Domain = First-Value @(
      (Read-Env "TECH_PERSISTENCE_DOMAIN"),
      "songuu.top"
    )
    BasePath = First-Value @(
      (Read-Env "TECH_PERSISTENCE_BASE_PATH"),
      "/tech-persistence/"
    )
  }
}

$profile = $providerProfiles[$Provider]
$providerPrefix = "TECH_PERSISTENCE_$($Provider.ToUpperInvariant())"
$resolvedHost = First-Value @($DeployHost, $profile.DeployHost)
$resolvedRemoteRoot = Normalize-RemoteRoot (First-Value @($RemoteRoot, $profile.RemoteRoot))
$resolvedDomain = First-Value @($Domain, $profile.Domain)
$resolvedBasePath = Normalize-BasePath (First-Value @($BasePath, $profile.BasePath))
$resolvedBuildOutput = Resolve-SiteOutput $BuildOutput
$resolvedReleaseId = First-Value @($ReleaseId, (Get-Date -Format "yyyyMMddHHmmss"))
$resolvedPublicOrigin = First-Value @(
  $PublicOrigin,
  (Read-Env "$providerPrefix`_PUBLIC_ORIGIN"),
  (Read-Env "TECH_PERSISTENCE_PUBLIC_ORIGIN"),
  "https://$resolvedDomain"
)

if ([string]::IsNullOrWhiteSpace($resolvedHost)) {
  throw "DeployHost is missing. Pass -DeployHost user@host or set $providerPrefix`_HOST."
}
if ($resolvedHost -notmatch "^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$") {
  throw "DeployHost must use the safe user@hostname form. Received: $resolvedHost"
}
if ([string]::IsNullOrWhiteSpace($resolvedDomain) -or $resolvedDomain -notmatch "^[A-Za-z0-9.-]+$") {
  throw "Domain must be a hostname without a scheme or path. Received: $resolvedDomain"
}
if ($resolvedReleaseId -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$") {
  throw "ReleaseId may contain only letters, digits, dot, underscore, and dash."
}

$publicUri = $null
if (-not [Uri]::TryCreate($resolvedPublicOrigin, [UriKind]::Absolute, [ref]$publicUri)) {
  throw "PublicOrigin must be an absolute HTTPS origin. Received: $resolvedPublicOrigin"
}
if (
  $publicUri.Scheme -ne "https" -or
  $publicUri.AbsolutePath -ne "/" -or
  -not [string]::IsNullOrEmpty($publicUri.Query) -or
  -not [string]::IsNullOrEmpty($publicUri.Fragment) -or
  -not [string]::IsNullOrEmpty($publicUri.UserInfo)
) {
  throw "PublicOrigin must use HTTPS and must not contain a path. Received: $resolvedPublicOrigin"
}
$resolvedPublicOrigin = $resolvedPublicOrigin.TrimEnd("/")

$normalizedVerifyPaths = @(
  foreach ($path in $VerifyPaths) {
    $normalizedPath = ([string]$path).Trim().TrimStart("/")
    if ($normalizedPath -match "['`r`n?#]" -or $normalizedPath -match "(^|/)\.\.(/|$)") {
      throw "VerifyPaths contains an unsafe relative path: $path"
    }
    $normalizedPath
  }
)

Step "Deploy config"
Write-ConfigLine "Provider" "$Provider ($($profile.Label))"
Write-ConfigLine "DeployHost" $resolvedHost
Write-ConfigLine "RemoteRoot" $resolvedRemoteRoot
Write-ConfigLine "BasePath" $resolvedBasePath
Write-ConfigLine "BuildOutput" $resolvedBuildOutput
Write-ConfigLine "ReleaseId" $resolvedReleaseId
Write-ConfigLine "BackupRetention" "$BackupRetention"
Write-ConfigLine "LoopbackHost" $resolvedDomain
Write-ConfigLine "PublicOrigin" $resolvedPublicOrigin

if ($DryRun) {
  Write-Host "DryRun: configuration validated; no local gates, build, archive, upload, remote mutation, or HTTP verification ran." -ForegroundColor Yellow
  return
}

if (-not $SkipTests) {
  Step "Local gates"
  $testRoot = Join-Path $RepoRoot "site/tests"
  $testFiles = @(
    Get-ChildItem -LiteralPath $testRoot -Filter "*.test.js" -File |
      Sort-Object -Property FullName |
      ForEach-Object { $_.FullName }
  )
  if ($testFiles.Count -eq 0) {
    throw "No site contract tests found under site/tests."
  }
  $testArgs = @("--test") + $testFiles
  Invoke-Native "node" $testArgs
} else {
  Write-Host "Skipping local gates (-SkipTests)." -ForegroundColor Yellow
}

if (-not $SkipBuild) {
  Step "Build static site"
  $buildScript = Join-Path $RepoRoot "site/build.js"
  if (-not (Test-Path -LiteralPath $buildScript -PathType Leaf)) {
    throw "Missing site/build.js."
  }
  Invoke-Native "node" @(
    "site/build.js",
    "--base",
    $resolvedBasePath,
    "--output",
    $resolvedBuildOutput
  )
} else {
  Write-Host "Skipping build (-SkipBuild); reusing $resolvedBuildOutput." -ForegroundColor Yellow
}

Step "Build self-check"
$distIndex = Join-Path $resolvedBuildOutput "index.html"
if (-not (Test-Path -LiteralPath $distIndex -PathType Leaf)) {
  throw "Missing built index: $distIndex"
}

$indexHtml = Get-Content -Raw -LiteralPath $distIndex
if ($indexHtml -notmatch [regex]::Escape($resolvedBasePath)) {
  throw "Built index does not reference the requested base path $resolvedBasePath."
}

$fileCount = (
  Get-ChildItem -LiteralPath $resolvedBuildOutput -Recurse -File |
    Measure-Object
).Count
if ($fileCount -lt 1) {
  throw "Build output is empty: $resolvedBuildOutput"
}
Write-Host "Build file count: $fileCount"

$archiveName = "tech-persistence-site-$Provider-$resolvedReleaseId.tgz"
$localArchive = Join-Path ([System.IO.Path]::GetTempPath()) $archiveName
$remoteArchive = "/tmp/$archiveName"
$remoteSwitched = $false

$quotedRoot = Quote-BashValue $resolvedRemoteRoot
$quotedReleaseId = Quote-BashValue $resolvedReleaseId
$quotedArchive = Quote-BashValue $remoteArchive

try {
  Step "Package + upload"
  Invoke-Native "tar" @(
    "-czf",
    $localArchive,
    "-C",
    $resolvedBuildOutput,
    "."
  )
  Invoke-Native "scp" @(
    "-o",
    "BatchMode=yes",
    $localArchive,
    "${resolvedHost}:$remoteArchive"
  )

  Step "Create immutable release + atomically switch current"
  $publish = @(
    "set -eu",
    "ROOT=$quotedRoot",
    "RELEASE_ID=$quotedReleaseId",
    "ARCHIVE=$quotedArchive",
    "KEEP=$BackupRetention",
    'RELEASES="$ROOT/releases"',
    'STAGE="$RELEASES/.staging-$RELEASE_ID"',
    'RELEASE="$RELEASES/$RELEASE_ID"',
    'CURRENT="$ROOT/current"',
    'PREVIOUS="$ROOT/previous"',
    'NEXT="$ROOT/.current-$RELEASE_ID"',
    'PREVIOUS_NEXT="$ROOT/.previous-$RELEASE_ID"',
    'trap ''rm -rf -- "$STAGE"; rm -f -- "$NEXT" "$PREVIOUS_NEXT" "$ARCHIVE"'' EXIT',
    'mkdir -p "$RELEASES"',
    'if [ -e "$CURRENT" ] && [ ! -L "$CURRENT" ]; then echo "current exists but is not a symlink" >&2; exit 1; fi',
    'if [ -e "$RELEASE" ]; then echo "release already exists: $RELEASE" >&2; exit 1; fi',
    'rm -rf -- "$STAGE"',
    'rm -f -- "$NEXT" "$PREVIOUS_NEXT"',
    'mkdir -p "$STAGE"',
    'tar -xzf "$ARCHIVE" -C "$STAGE"',
    'test -f "$STAGE/index.html"',
    'chmod -R a+rX "$STAGE"',
    'mv "$STAGE" "$RELEASE"',
    'OLD=""',
    'if [ -L "$CURRENT" ]; then OLD=$(readlink -f "$CURRENT"); test -n "$OLD"; fi',
    'if [ -n "$OLD" ]; then ln -s "$OLD" "$PREVIOUS_NEXT"; mv -Tf "$PREVIOUS_NEXT" "$PREVIOUS"; fi',
    'ln -s "$RELEASE" "$NEXT"',
    'mv -Tf "$NEXT" "$CURRENT"',
    'rm -f -- "$ARCHIVE"',
    'ACTIVE=$(readlink -f "$CURRENT")',
    'PRUNE=$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf ''%T@ %p\n'' | sort -rn | tail -n +$((KEEP + 2)) | cut -d'' '' -f2- || true)',
    'if [ -n "$PRUNE" ]; then printf ''%s\n'' "$PRUNE" | while IFS= read -r OLD_RELEASE; do if [ "$OLD_RELEASE" != "$ACTIVE" ]; then rm -rf -- "$OLD_RELEASE"; fi; done; fi',
    'trap - EXIT',
    'echo "ACTIVE_RELEASE=$ACTIVE"',
    'echo "PREVIOUS_RELEASE=$OLD"',
    'echo "BACKUP_RETENTION=$KEEP"',
    'echo "RELEASE_COUNT=$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d | wc -l)"'
  ) -join "; "
  Invoke-Native "ssh" @(
    "-o",
    "BatchMode=yes",
    $resolvedHost,
    $publish
  )
  $remoteSwitched = $true

  if (-not $SkipVerify) {
    Step "Remote loopback verification"
    $quotedHostHeader = Quote-BashValue "Host:$resolvedDomain"
    $quotedBasePath = Quote-BashValue $resolvedBasePath
    $quotedLoopbackScheme = Quote-BashValue $LoopbackScheme
    $quotedVerifyPaths = (
      $normalizedVerifyPaths |
        ForEach-Object { Quote-BashValue $_ }
    ) -join " "
    $loopback = @(
      "set -eu",
      "HOST_HEADER=$quotedHostHeader",
      "BASE=$quotedBasePath",
      "SCHEME=$quotedLoopbackScheme",
      "for PATH_SUFFIX in $quotedVerifyPaths; do STATUS=`$(curl -kSs -o /dev/null -w '%{http_code}' -H `"`$HOST_HEADER`" `"`${SCHEME}://127.0.0.1`${BASE}`${PATH_SUFFIX}`"); echo `"loopback `${BASE}`${PATH_SUFFIX} status=`${STATUS}`"; test `"`$STATUS`" = `"200`"; done"
    ) -join "; "
    Invoke-Native "ssh" @(
      "-o",
      "BatchMode=yes",
      $resolvedHost,
      $loopback
    )

    Step "Public HTTPS verification"
    $curlCommand = if (Get-Command "curl.exe" -ErrorAction SilentlyContinue) {
      "curl.exe"
    } else {
      "curl"
    }
    foreach ($path in $normalizedVerifyPaths) {
      $publicUrl = "$resolvedPublicOrigin$resolvedBasePath$path"
      Write-Host "Verify $publicUrl"
      Invoke-Native $curlCommand @(
        "--fail",
        "--silent",
        "--show-error",
        "--head",
        $publicUrl
      )
    }
  } else {
    Write-Host "Skipping loopback and public verification (-SkipVerify)." -ForegroundColor Yellow
  }
} catch {
  $deploymentError = $_
  if ($remoteSwitched -and -not $SkipVerify) {
    Write-Warning "Post-switch verification failed; attempting to restore the previous release."
    $rollback = @(
      "set -eu",
      "ROOT=$quotedRoot",
      "RELEASE_ID=$quotedReleaseId",
      'CURRENT="$ROOT/current"',
      'PREVIOUS="$ROOT/previous"',
      'NEXT="$ROOT/.current-rollback-$RELEASE_ID"',
      'test -L "$PREVIOUS"',
      'TARGET=$(readlink -f "$PREVIOUS")',
      'test -d "$TARGET"',
      'rm -f -- "$NEXT"',
      'ln -s "$TARGET" "$NEXT"',
      'mv -Tf "$NEXT" "$CURRENT"',
      'echo "ROLLED_BACK_TO=$TARGET"'
    ) -join "; "
    try {
      Invoke-Native "ssh" @(
        "-o",
        "BatchMode=yes",
        $resolvedHost,
        $rollback
      )
    } catch {
      Write-Warning "Automatic rollback also failed: $($_.Exception.Message)"
    }
  }
  throw $deploymentError
} finally {
  if (-not $KeepArchive -and (Test-Path -LiteralPath $localArchive)) {
    Remove-Item -LiteralPath $localArchive -Force
  }
}

Step "Deploy complete"
Write-Host "Target: $resolvedPublicOrigin$resolvedBasePath" -ForegroundColor Green
Write-Host "Release: $resolvedRemoteRoot/releases/$resolvedReleaseId" -ForegroundColor Green
Write-Host "Current: $resolvedRemoteRoot/current" -ForegroundColor Green
