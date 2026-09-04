param(
    [string]$SshHost = '47.253.230.197',
    [string]$SshUser = 'root',
    [int]$LocalPort = 55434,
    [int]$RemotePort = 55433,
    [int]$RetrySeconds = 5
)

$ErrorActionPreference = 'Stop'
if ($SshHost -notmatch '^[A-Za-z0-9.-]+$') { throw 'SshHost contains unsupported characters' }
if ($SshUser -notmatch '^[A-Za-z0-9._-]+$') { throw 'SshUser contains unsupported characters' }
if ($LocalPort -lt 1 -or $LocalPort -gt 65535) { throw 'LocalPort is out of range' }
if ($RemotePort -lt 1 -or $RemotePort -gt 65535) { throw 'RemotePort is out of range' }
if ($RetrySeconds -lt 1 -or $RetrySeconds -gt 300) { throw 'RetrySeconds is out of range' }
$mutex = [System.Threading.Mutex]::new($false, 'Local\TechPersistenceDbxTunnel')
$ownsMutex = $false

try {
    try {
        $ownsMutex = $mutex.WaitOne(0, $false)
    } catch [System.Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) { exit 0 }

    $ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
    if (-not (Test-Path -LiteralPath $ssh -PathType Leaf)) {
        throw "OpenSSH client not found at $ssh"
    }

    $sshArguments = @(
        '-N', '-T',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-L', "127.0.0.1:${LocalPort}:127.0.0.1:${RemotePort}",
        "${SshUser}@${SshHost}"
    )

    while ($true) {
        # SSH exits after a failed health check; the bounded delay prevents a hot retry loop.
        $process = Start-Process -FilePath $ssh -ArgumentList $sshArguments `
            -WindowStyle Hidden -Wait -PassThru
        Start-Sleep -Seconds ([Math]::Max(1, $RetrySeconds))
    }
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
