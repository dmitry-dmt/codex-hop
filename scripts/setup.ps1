<#
.SYNOPSIS
  Point the Codex client at a locally running codex-hop.

.DESCRIPTION
  Changes exactly one thing: the top-level openai_base_url in the Codex config.
  It takes a timestamped backup first, shows the change before making it, and
  refuses to guess when the file is ambiguous.

  It does not install a service, does not create a scheduled task, and does not
  start anything in the background. You start the router yourself and you can
  see that it is running.

.PARAMETER Port
  Port the router listens on. Default 8788.

.PARAMETER Yes
  Apply without the confirmation prompt.
#>
[CmdletBinding()]
param(
  [int]$Port = 8788,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "setup: $msg" -ForegroundColor Red; exit 1 }
function Note($msg) { Write-Host "  $msg" -ForegroundColor DarkGray }

# --- runtime -----------------------------------------------------------------
$nodeVersion = (& node --version) 2>$null
if (-not $nodeVersion) { Fail 'Node not found on PATH. codex-hop needs Node 22.15 or newer.' }
$v = $nodeVersion.TrimStart('v').Split('.')
if ([int]$v[0] -lt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -lt 15)) {
  Fail "Node $nodeVersion is too old. codex-hop needs 22.15 or newer (it decodes zstd natively)."
}
Write-Host "Node $nodeVersion" -ForegroundColor Green

# --- locate the Codex config -------------------------------------------------
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$configPath = Join-Path $codexHome 'config.toml'
if (-not (Test-Path $configPath)) { Fail "Codex config not found at $configPath" }
Write-Host "Config $configPath" -ForegroundColor Green

$targetUrl = "http://127.0.0.1:$Port"
$lines = [System.IO.File]::ReadAllLines($configPath)

# Only the top-level table counts: a key of the same name inside [some.section]
# belongs to that section and must not be touched.
$firstSection = $lines.Length
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match '^\s*\[') { $firstSection = $i; break }
}

$hits = @()
for ($i = 0; $i -lt $firstSection; $i++) {
  if ($lines[$i] -match '^\s*openai_base_url\s*=') { $hits += $i }
}

if ($hits.Count -gt 1) {
  Fail "openai_base_url appears $($hits.Count) times at the top level of $configPath. Fix that by hand first; this script will not guess."
}

$existing = if ($hits.Count -eq 1) { $lines[$hits[0]].Trim() } else { $null }
if ($existing -and $existing -match [regex]::Escape($targetUrl)) {
  Write-Host "Already pointing at $targetUrl. Nothing to do." -ForegroundColor Green
  exit 0
}

# --- show, then ask ----------------------------------------------------------
Write-Host ''
Write-Host 'This will change one line in your Codex config:' -ForegroundColor Cyan
if ($existing) { Note "- $existing" } else { Note '- (no openai_base_url set)' }
Note "+ openai_base_url = `"$targetUrl`""
Write-Host ''

if (-not $Yes) {
  $answer = Read-Host 'Apply? [y/N]'
  if ($answer -notmatch '^(y|yes)$') { Write-Host 'Cancelled. Nothing was changed.'; exit 0 }
}

# --- back up, then write atomically -----------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$configPath.bak-codex-hop-$stamp"
Copy-Item $configPath $backup
Note "Backup: $backup"

$newLine = "openai_base_url = `"$targetUrl`""
if ($hits.Count -eq 1) {
  $lines[$hits[0]] = $newLine
  $out = $lines
} else {
  # Insert at the end of the top-level table, before the first section header,
  # keeping a blank line in front of that header so the file still reads well.
  $out = @()
  if ($firstSection -gt 0) {
    $head = @($lines[0..($firstSection - 1)])
    while ($head.Count -gt 0 -and $head[-1].Trim() -eq '') { $head = $head[0..($head.Count - 2)] }
    $out += $head
  }
  $out += $newLine
  if ($firstSection -lt $lines.Length) {
    $out += ''
    $out += $lines[$firstSection..($lines.Length - 1)]
  }
}

# TOML is UTF-8. A BOM makes some parsers choke, so write without one.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$tmp = "$configPath.codex-hop-tmp"
[System.IO.File]::WriteAllLines($tmp, $out, $utf8NoBom)
Move-Item -Force $tmp $configPath

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next:' -ForegroundColor Cyan
Note "1. set DEEPSEEK_API_KEY in your environment"
Note "2. npm start"
Note "3. fully restart Codex (quit, not just close the window)"
Write-Host ''
Write-Host 'If anything goes wrong, remove this line from your Codex config and restart Codex:' -ForegroundColor Yellow
Write-Host "    $newLine" -ForegroundColor Yellow
Write-Host "Or run scripts\uninstall.ps1" -ForegroundColor Yellow
