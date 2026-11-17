<#
.SYNOPSIS
  Install or upgrade dsh-agent-bridge in a DSH profile.
.DESCRIPTION
  Backs up the profile's package.json, pnpm-lock.yaml and cordis files, then
  adds the requested build. The new package is added before anything is removed:
  pnpm replaces the dependency in place, so a failed install cannot leave the
  profile without a bridge. On failure the backup is restored and the script
  exits non-zero. It never reads or prints the bridge token.

  Sources:
    release  the GitHub release tarball (default)
    github   the GitHub tag: github:FloStyle/dsh-agent-bridge#v<version>
    local    this clone, for development
.PARAMETER Source
  release, github or local.
.PARAMETER Version
  Version to install. Defaults to the latest GitHub release (release/github) or
  the version in this clone (local).
.PARAMETER Profile
  DSH profile to change. Defaults to desktop.
.EXAMPLE
  ./scripts/install.ps1 -Source release -Version 0.6.1 -Profile desktop
.EXAMPLE
  ./scripts/install.ps1 -Source local -Profile bridge-test
#>
[CmdletBinding()]
param(
  [ValidateSet('release', 'github', 'local')]
  [string]$Source = 'release',
  [string]$Version,
  [string]$Profile = 'desktop',
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)
$ErrorActionPreference = 'Stop'

$packageName = 'dsh-agent-bridge'
$repoSlug = 'FloStyle/dsh-agent-bridge'
$profileDir = Join-Path (Join-Path $HOME '.dsh/profiles') $Profile
$backupDir = Join-Path (Join-Path $HOME '.dsh/backups') ("{0}-{1}" -f $Profile, (Get-Date -Format 'yyyyMMdd-HHmmss'))
$backupFiles = 'package.json', 'pnpm-lock.yaml', 'cordis.yml', 'cordis.patch.yml'

function Get-LatestReleaseVersion {
  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repoSlug/releases/latest" `
      -Headers @{ 'User-Agent' = 'dsh-agent-bridge-install' } -TimeoutSec 20
    return [string]$release.tag_name -replace '^v', ''
  } catch {
    throw "could not read the latest release of $repoSlug ($($_.Exception.Message)). Pass -Version, for example -Version 0.6.1."
  }
}

if (-not $Version) {
  if ($Source -eq 'local') {
    $Version = (Get-Content (Join-Path $Repo 'package.json') -Raw | ConvertFrom-Json).version
  } else {
    $Version = Get-LatestReleaseVersion
  }
}
if ($Version -notmatch '^\d+\.\d+\.\d+') { throw "invalid -Version '$Version'" }

$spec = switch ($Source) {
  'release' { "https://github.com/$repoSlug/releases/download/v$Version/$packageName-$Version.tgz" }
  'github' { "github:$repoSlug#v$Version" }
  'local' { 'file:' + ($Repo -replace '\\', '/') }
}

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw 'the dsh CLI is not on PATH; use the dsh bundled with DeepSeek Harness'
}

# ---- back up before touching anything ------------------------------------------------------------
$restore = @()
if (Test-Path $profileDir) {
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  foreach ($file in $backupFiles) {
    $sourcePath = Join-Path $profileDir $file
    if (Test-Path $sourcePath) {
      Copy-Item $sourcePath (Join-Path $backupDir $file)
      $restore += $file
    }
  }
  Write-Host "Backed up $($restore.Count) file(s) to $backupDir"
} else {
  Write-Host "Profile '$Profile' does not exist yet; dsh initializes it on first add."
}

function Restore-ProfileBackup {
  if (-not (Test-Path $backupDir)) { return }
  foreach ($file in $restore) { Copy-Item (Join-Path $backupDir $file) (Join-Path $profileDir $file) -Force }
  Write-Host "Restored the previous profile files from $backupDir"
}

# ---- add first; never remove before the replacement is in ---------------------------------------
Write-Host "Installing $packageName $Version from $Source into profile '$Profile'"
Write-Host "  $spec"
& dsh plugin --profile $Profile add $spec
if ($LASTEXITCODE -ne 0) {
  Restore-ProfileBackup
  throw "dsh plugin add failed (exit code $LASTEXITCODE); the profile was restored"
}

# ---- enablement check (I4) -----------------------------------------------------------------------
$manifestPath = Join-Path $profileDir 'package.json'
$installed = $null
$installedManifest = Join-Path $profileDir "node_modules/$packageName/package.json"
if (Test-Path $installedManifest) { $installed = (Get-Content $installedManifest -Raw | ConvertFrom-Json).version }

$bundleState = 'unknown'
if (Test-Path $manifestPath) {
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $bundles = @()
  if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) { $bundles = @($manifest.dsh.profile.bundles) }
  if ($bundles -contains $packageName) {
    $bundleState = 'dsh added it'
  } else {
    if (-not $manifest.dsh) { $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
    if (-not $manifest.dsh.profile) { $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
    if (-not $manifest.dsh.profile.bundles) { $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }
    $manifest.dsh.profile.bundles = @($bundles) + $packageName
    $json = $manifest | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($manifestPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
    $bundleState = 'added by this script'
  }
}

Write-Host ''
Write-Host "Installed $packageName $Version into profile '$Profile'"
Write-Host "  installed version: $($installed ?? 'not found')"
Write-Host "  dsh.profile.bundles: $bundleState"
Write-Host ''
Write-Host 'Restart DeepSeek Harness while no session is working, then check:'
Write-Host '  node scripts/doctor.mjs'
Write-Host 'Rollback:'
if (Test-Path $backupDir) {
  Write-Host "  copy $backupDir\* back to $profileDir and restart DSH"
}
