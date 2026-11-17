<#
.SYNOPSIS
  Print or run the `claude mcp add` command for this clone.
.EXAMPLE
  ./scripts/connect-claude-code.ps1
.EXAMPLE
  ./scripts/connect-claude-code.ps1 -Execute
#>
[CmdletBinding()]
param(
  [string]$AgentName = 'claude-code',
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'

$entry = Join-Path $Repo 'mcp/mcp.mjs'
if (-not (Test-Path $entry)) { throw "no mcp/mcp.mjs in $Repo; point -Repo at the dsh-agent-bridge clone" }

$cliArgs = @(
  'mcp', 'add', 'dsh-agent-bridge',
  '--env', "DSH_AGENT_NAME=$AgentName",
  '--', 'node', $entry
)
$rendered = ($cliArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
Write-Host "claude $rendered"

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  throw "the claude CLI is not on PATH; run the command above yourself or install Claude Code first"
}
if (-not $Execute) {
  Write-Host ''
  Write-Host 'Re-run with -Execute to register it now.'
  return
}
& claude @args
if ($LASTEXITCODE -ne 0) { throw "claude mcp add failed with exit code $LASTEXITCODE" }
Write-Host 'Registered. Restart Claude Code, then ask it to call dsh_list.'

