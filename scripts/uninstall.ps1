<#
.SYNOPSIS
  Point the Codex client back at its own backend.

.DESCRIPTION
  Removes the top-level openai_base_url only if it still points at a loopback
  address -- that is, only if it is still ours. If you have since pointed Codex
  somewhere else on purpose, this script leaves your setting alone.

.PARAMETER Yes
  Apply without the confirmation prompt.
#>
[CmdletBinding()]
param([switch]$Yes)

$ErrorActionPreference = 'Stop'
function Fail($msg) { Write-Host "uninstall: $msg" -ForegroundColor Red; exit 1 }
function Note($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$configPath = Join-Path $codexHome 'config.toml'
if (-not (Test-Path $configPath)) { Fail "Codex config not found at $configPath" }

$lines = [System.IO.File]::ReadAllLines($configPath)

$firstSection = $lines.Length
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match '^\s*\[') { $firstSection = $i; break }
}

$hit = -1
for ($i = 0; $i -lt $firstSection; $i++) {
  if ($lines[$i] -match '^\s*openai_base_url\s*=') { $hit = $i; break }
}

if ($hit -lt 0) {
  Write-Host 'No top-level openai_base_url set. Nothing to undo.' -ForegroundColor Green
  exit 0
}

$current = $lines[$hit].Trim()
if ($current -notmatch '127\.0\.0\.1|localhost|\[::1\]') {
  Write-Host 'Leaving your setting alone -- it no longer points at a local router:' -ForegroundColor Yellow
  Note $current
  exit 0
}

Write-Host 'This will remove one line from your Codex config:' -ForegroundColor Cyan
Note "- $current"
Write-Host ''

if (-not $Yes) {
  $answer = Read-Host 'Apply? [y/N]'
  if ($answer -notmatch '^(y|yes)$') { Write-Host 'Cancelled. Nothing was changed.'; exit 0 }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$configPath.bak-codex-hop-$stamp"
Copy-Item $configPath $backup
Note "Backup: $backup"

$out = @()
for ($i = 0; $i -lt $lines.Length; $i++) { if ($i -ne $hit) { $out += $lines[$i] } }

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$tmp = "$configPath.codex-hop-tmp"
[System.IO.File]::WriteAllLines($tmp, $out, $utf8NoBom)
Move-Item -Force $tmp $configPath

Write-Host ''
Write-Host 'Done. Fully restart Codex and it will talk to its own backend again.' -ForegroundColor Green
Write-Host 'Router data (provider choice per thread) is left in place; delete it if you want:' -ForegroundColor DarkGray
Note (Join-Path $env:LOCALAPPDATA 'codex-hop')
