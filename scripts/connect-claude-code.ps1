<#
.SYNOPSIS
  Deprecated wrapper: dsh-bridge connect claude.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$AgentName = 'claude-code',
  [string]$Profile = 'desktop',
  [switch]$Execute
)
Write-Warning 'deprecated: use dsh-bridge connect claude'
$cli = Join-Path $PSScriptRoot '..\bin\dsh-bridge.cmd'
$cliArgs = @('connect', 'claude', '--name', $AgentName, '--profile', $Profile)
if ($Execute) { $cliArgs += '--execute' }
& $cli @cliArgs
exit $LASTEXITCODE
