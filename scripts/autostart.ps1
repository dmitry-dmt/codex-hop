<#
.SYNOPSIS
  Start the router at logon and keep it running.

.DESCRIPTION
  Puts a shortcut in your Startup folder, so the router comes up with your session
  and restarts itself if it exits.

  A scheduled task would look like the tidier choice, and on many machines it is.
  It is not used here because it runs outside the interactive session and does not
  always resolve the same paths: a router started that way can come up against a
  different data directory, which looks exactly like a working router with no
  history and no MCP servers. A Startup entry runs in the session you actually
  work in.

  Nothing is installed until you run this, and -Remove takes it back out. No
  administrator rights are needed.
#>
param([switch]$Remove)
$ErrorActionPreference = 'Stop'

$entry   = Join-Path ([Environment]::GetFolderPath('Startup')) 'codex-hop.lnk'
$service = Join-Path $PSScriptRoot 'service.ps1'

if ($Remove) {
  if (-not (Test-Path $entry)) { Write-Host "Nothing to remove: no entry at $entry"; return }
  Remove-Item $entry -Force
  Write-Host "Removed $entry"
  Write-Host "A router that is already running is left alone; stop it yourself to finish."
  return
}

if (-not (Test-Path $service)) { throw "service.ps1 is not next to this script: $service" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node is not on PATH" }
if (-not [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')) {
  Write-Warning 'DEEPSEEK_API_KEY is not set for your account, only possibly in this shell.'
  Write-Warning 'A logon launcher cannot see that. Set it with:'
  Write-Warning '  setx DEEPSEEK_API_KEY "sk-..."'
}

# A shortcut rather than a .cmd on purpose: a .cmd is read in the OEM code page, so
# an install path outside ASCII would arrive at cmd.exe as mojibake. A .lnk stores
# its target as Unicode.
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($entry)
$lnk.TargetPath = (Get-Command powershell).Source
$lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $service + '"'
$lnk.WorkingDirectory = Split-Path -Parent $service
$lnk.WindowStyle = 7
$lnk.Description = 'Keeps codex-hop running.'
$lnk.Save()

Write-Host "Registered $entry"
Write-Host "The router will start at every logon."
Write-Host ""
Write-Host "Start it now, without logging out:"
Write-Host ('  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $service + '"')
Write-Host ""
Write-Host "Remove it:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove"
