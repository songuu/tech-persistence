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
    [int] $RemotePort = 5432,

    [string] $TaskName = 'TechPersistence-TranscriptPostgresTunnel'
)

$ErrorActionPreference = 'Stop'

$ssh = Get-Command ssh.exe -ErrorAction Stop
$forward = "127.0.0.1:${LocalPort}:${RemoteHost}:${RemotePort}"
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
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
$actionArguments = $sshArguments -join ' '

# The task must own ssh.exe directly. If PowerShell owns it as a child,
# Stop-ScheduledTask can leave the forwarding process behind on Windows.
$action = New-ScheduledTaskAction -Execute $ssh.Source -Argument $actionArguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity
$principal = New-ScheduledTaskPrincipal `
    -UserId $currentIdentity `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
$definition = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Keeps the loopback-only Tech Persistence transcript PostgreSQL SSH tunnel available.'

Register-ScheduledTask -TaskName $TaskName -InputObject $definition -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$task = Get-ScheduledTask -TaskName $TaskName
[pscustomobject]@{
    TaskName = $task.TaskName
    State = $task.State
    SshExecutable = $ssh.Source
    LocalPort = $LocalPort
    RemoteEndpoint = "${RemoteHost}:${RemotePort}"
}
