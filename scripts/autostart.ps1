<#
.SYNOPSIS
  Start the router at logon and keep it running.

.DESCRIPTION
  Registers a scheduled task for the current user that runs service.ps1 at logon.
  That is the difference between a router that dies with the window it was started
  from and one that is simply there.

  Nothing is registered until you run this, and -Remove takes it back out. No
  administrator rights are needed: the task belongs to your own account.
#>
param([switch]$Remove)
$ErrorActionPreference = 'Stop'

$taskName = 'codex-hop'
$service  = Join-Path $PSScriptRoot 'service.ps1'

if ($Remove) {
  if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    Write-Host "No '$taskName' task is registered - nothing to remove."
    return
  }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed the '$taskName' logon task."
  Write-Host "A router that is already running is left alone; stop it yourself to finish."
  return
}

if (-not (Test-Path $service)) { throw "service.ps1 is not next to this script: $service" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node is not on PATH" }
if (-not [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')) {
  Write-Warning "DEEPSEEK_API_KEY is not set in your user environment. A logon task"
  Write-Warning "cannot see a key you exported in one shell session, so set it with:"
  Write-Warning "  setx DEEPSEEK_API_KEY ""sk-..."""
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
  '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $service + '"')
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Keeps codex-hop running.' -Force | Out-Null

Write-Host "Registered '$taskName'. It starts at every logon."
Write-Host ""
Write-Host "Start it now, without logging out:"
Write-Host "  Start-ScheduledTask -TaskName $taskName"
Write-Host ""
Write-Host "Remove it:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove"
