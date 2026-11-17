<#
.SYNOPSIS
  Remove dsh-agent-bridge from a DSH profile.
.DESCRIPTION
  Removes the package and its dsh.profile.bundles entry. The private state file
  (~/.dsh/agent-bridge.json) and the audit log are kept unless you confirm their
  removal, or pass -Purge. Tokens are never printed.
.PARAMETER Profile
  DSH profile to clean. Defaults to desktop.
.PARAMETER Purge
  Delete the state file and audit log without asking.
.EXAMPLE
  ./scripts/uninstall.ps1
.EXAMPLE
  ./scripts/uninstall.ps1 -Profile bridge-test -Purge
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$Purge
)
$ErrorActionPreference = 'Stop'

$packageName = 'dsh-agent-bridge'
$profileDir = Join-Path (Join-Path $HOME '.dsh/profiles') $Profile
$stateFile = Join-Path $HOME '.dsh/agent-bridge.json'
$auditFile = Join-Path $HOME '.dsh/agent-bridge-audit.jsonl'

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw 'the dsh CLI is not on PATH; use the dsh bundled with DeepSeek Harness'
}

Write-Host "Removing $packageName from profile '$Profile'"
& dsh plugin --profile $Profile remove $packageName
if ($LASTEXITCODE -ne 0) {
  Write-Warning "dsh plugin remove failed (exit $LASTEXITCODE); the package may already be absent"
}

$manifestPath = Join-Path $profileDir 'package.json'
if (Test-Path $manifestPath) {
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $bundles = @()
  if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) { $bundles = @($manifest.dsh.profile.bundles) }
  if ($bundles -contains $packageName) {
    $manifest.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $packageName })
    $json = $manifest | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($manifestPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Removed $packageName from dsh.profile.bundles"
  }
}

$privateFiles = @($stateFile, $auditFile, "$auditFile.1") | Where-Object { Test-Path $_ }
if ($privateFiles.Count -eq 0) {
  Write-Host 'No private bridge files to remove.'
} else {
  $answer = 'n'
  if ($Purge) {
    $answer = 'y'
  } else {
    Write-Host 'Private files that can be deleted:'
    foreach ($file in $privateFiles) { Write-Host "  $file" }
    try {
      $answer = Read-Host 'Delete them? They hold the bridge token and audit history [y/N]'
    } catch {
      Write-Host 'Non-interactive session: keeping the private files (pass -Purge to delete them).'
      $answer = 'n'
    }
  }
  if ($answer -match '^(y|yes)$') {
    foreach ($file in $privateFiles) { Remove-Item $file -Force; Write-Host "Deleted $file" }
  } else {
    Write-Host 'Kept the private bridge files.'
  }
}

Write-Host ''
Write-Host 'Restart DeepSeek Harness to unload the plugin.'
