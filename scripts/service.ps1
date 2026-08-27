<#
.SYNOPSIS
  Keep the router running, restarting it if it exits.

.DESCRIPTION
  autostart.ps1 registers this as a logon task, which is what makes the router
  survive closing the window it was started from. Run it directly and it behaves
  the same way in the foreground.

  Each run of the router writes its own log file: a redirect that truncates would
  let a router restarting in a loop erase the history needed to diagnose it. Files
  older than 14 days are removed at startup so the directory does not grow forever.
#>
$ErrorActionPreference = 'Stop'

$app  = Split-Path -Parent $PSScriptRoot
$data = if ($env:CODEX_HOP_DATA) { $env:CODEX_HOP_DATA } else { Join-Path $env:LOCALAPPDATA 'codex-hop' }
$logs = Join-Path $data 'logs'
$port = if ($env:CODEX_HOP_PORT) { [int]$env:CODEX_HOP_PORT } else { 8788 }

New-Item -ItemType Directory -Force $data | Out-Null
New-Item -ItemType Directory -Force $logs | Out-Null

# A logon task starts before any interactive profile has run, so the key has to
# come from the user environment rather than from the current session.
if (-not $env:DEEPSEEK_API_KEY) {
  $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
}

function Test-PortInUse([int]$p) {
  try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $p); $c.Close(); $true }
  catch { $false }
}

Get-ChildItem (Join-Path $logs 'router-*.log') -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
  Remove-Item -Force -ErrorAction SilentlyContinue

while ($true) {
  if (Test-PortInUse $port) {
    # Something else already holds the port. Starting a router here would only
    # produce one that exits on bind, and a restart loop that explains nothing.
    Start-Sleep -Seconds 30
    continue
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $out = Join-Path $logs "router-$stamp.log"
  $err = Join-Path $logs "router-$stamp.err.log"

  $p = Start-Process -FilePath 'node' -ArgumentList 'src/router.js' `
    -WorkingDirectory $app -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru

  Set-Content -Path (Join-Path $data 'router.pid') -Value $p.Id
  Set-Content -Path (Join-Path $data 'router.current') -Value $out

  Wait-Process -Id $p.Id
  Start-Sleep -Seconds 10
}
