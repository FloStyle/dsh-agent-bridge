<#
.SYNOPSIS
  Deprecated wrapper: dsh-bridge install.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet('release', 'github', 'local')]
  [string]$Source = 'release',
  [string]$Version,
  [string]$Profile = 'desktop'
)
Write-Warning 'deprecated: use dsh-bridge install'
$cli = Join-Path $PSScriptRoot '..\bin\dsh-bridge.cmd'
$cliArgs = @('install', '--source', $Source, '--profile', $Profile)
if ($Version) { $cliArgs += @('--version', $Version) }
& $cli @cliArgs
exit $LASTEXITCODE
