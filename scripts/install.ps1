<#
.SYNOPSIS
  Install or update the DSH Agent Bridge plugin from this git clone.
.DESCRIPTION
  Removes any installed copy, adds this folder as a file: plugin, and tells you
  to restart DeepSeek Harness. DSH caches plugin modules, so an in-place update
  only takes effect after a restart.
.EXAMPLE
  ./scripts/install.ps1
.EXAMPLE
  ./scripts/install.ps1 -Profile desktop -Force
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw "the dsh CLI is not on PATH; run this from a shell that can call the dsh bundled with DeepSeek Harness"
}
$manifest = Join-Path $Repo 'package.json'
if (-not (Test-Path $manifest)) { throw "no package.json in $Repo; point -Repo at the dsh-agent-bridge clone" }
$version = (Get-Content $manifest -Raw | ConvertFrom-Json).version
$state = Join-Path $HOME '.dsh/agent-bridge.json'
if ((Test-Path $state) -and -not $Force) {
  Write-Host "Keeping the existing token in $state (pass -Force to rotate it)."
}

$spec = 'file:' + ($Repo -replace '\\', '/')
Write-Host "Installing dsh-agent-bridge $version into profile '$Profile'"
& dsh plugin --profile $Profile remove dsh-agent-bridge 2>&1 | Out-Host
& dsh plugin --profile $Profile add $spec
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

Write-Host ''
Write-Host 'Restart DeepSeek Harness while no session is working, then verify the build:'
Write-Host '  node scripts/health.mjs'
