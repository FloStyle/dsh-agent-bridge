<#
.SYNOPSIS
  Deprecated wrapper: dsh-bridge uninstall.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [switch]$Purge
)
Write-Warning 'deprecated: use dsh-bridge uninstall'
$cli = Join-Path $PSScriptRoot '..\bin\dsh-bridge.cmd'
$cliArgs = @('uninstall', '--profile', $Profile)
if ($Purge) { $cliArgs += '--purge' }
& $cli @cliArgs
exit $LASTEXITCODE
