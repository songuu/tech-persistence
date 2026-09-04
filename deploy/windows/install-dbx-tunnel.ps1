param(
    [string]$SshHost = '47.253.230.197',
    [string]$SshUser = 'root',
    [int]$LocalPort = 55434,
    [int]$RemotePort = 55433,
    [switch]$Start
)

$ErrorActionPreference = 'Stop'
if ($SshHost -notmatch '^[A-Za-z0-9.-]+$') { throw 'SshHost contains unsupported characters' }
if ($SshUser -notmatch '^[A-Za-z0-9._-]+$') { throw 'SshUser contains unsupported characters' }
if ($LocalPort -lt 1 -or $LocalPort -gt 65535) { throw 'LocalPort is out of range' }
if ($RemotePort -lt 1 -or $RemotePort -gt 65535) { throw 'RemotePort is out of range' }
$source = Join-Path $PSScriptRoot 'dbx-tunnel-watchdog.ps1'
$targetDirectory = Join-Path $env:LOCALAPPDATA 'TechPersistence'
$target = Join-Path $targetDirectory 'dbx-tunnel-watchdog.ps1'
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "DBX tunnel watchdog not found at $source"
}

New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) {
    throw 'DBX tunnel watchdog copy hash mismatch'
}

$watchdogArguments = @(
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-File', $target,
    '-SshHost', $SshHost, '-SshUser', $SshUser,
    '-LocalPort', $LocalPort, '-RemotePort', $RemotePort
)
$quotedTarget = '"' + $target + '"'
$runCommand = ('"{0}" -NoProfile -NonInteractive -WindowStyle Hidden ' +
    '-ExecutionPolicy Bypass -File {1} -SshHost {2} -SshUser {3} ' +
    '-LocalPort {4} -RemotePort {5}') -f $powershell, $quotedTarget,
    $SshHost, $SshUser, $LocalPort, $RemotePort

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name 'TechPersistenceDbxTunnel' `
    -Value $runCommand -PropertyType String -Force | Out-Null

if ($Start) {
    Start-Process -FilePath $powershell -ArgumentList $watchdogArguments -WindowStyle Hidden
}

[pscustomobject]@{
    installed = $true
    startup = 'HKCU Run'
    localEndpoint = "127.0.0.1:$LocalPort"
    watchdog = $target
}
