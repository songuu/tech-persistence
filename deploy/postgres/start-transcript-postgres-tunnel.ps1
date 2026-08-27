[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[^\s@]+@[^\s@]+$')]
    [string] $SshDestination,

    [ValidateRange(1024, 65535)]
    [int] $LocalPort = 55434,

    [ValidatePattern('^[A-Za-z0-9._:-]+$')]
    [string] $RemoteHost = '127.0.0.1',

    [ValidateRange(1, 65535)]
    [int] $RemotePort = 5432
)

$ErrorActionPreference = 'Stop'

$ssh = Get-Command ssh.exe -ErrorAction Stop
$forward = "127.0.0.1:${LocalPort}:${RemoteHost}:${RemotePort}"
$sshArguments = @(
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'TCPKeepAlive=yes',
    '-o', 'LogLevel=ERROR',
    '-L', $forward,
    $SshDestination
)

& $ssh.Source @sshArguments
$sshExitCode = $LASTEXITCODE
if ($sshExitCode -ne 0) {
    throw "Transcript PostgreSQL SSH tunnel exited with code ${sshExitCode}."
}

