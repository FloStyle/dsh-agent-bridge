<#
.SYNOPSIS
  Print or run the `claude mcp add` command for this installation.
.DESCRIPTION
  Prefers the plugin installed in a DSH profile; falls back to this clone.
  The config contains no token: the MCP client reads the URL and token from
  ~/.dsh/agent-bridge.json at run time.
.EXAMPLE
  ./scripts/connect-claude-code.ps1
.EXAMPLE
  ./scripts/connect-claude-code.ps1 -Profile desktop -Execute
#>
[CmdletBinding()]
param(
  [string]$AgentName = 'claude-code',
  [string]$Profile = 'desktop',
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'

$installed = Join-Path $HOME ".dsh/profiles/$Profile/node_modules/dsh-agent-bridge/mcp/mcp.mjs"
$local = Join-Path $Repo 'mcp/mcp.mjs'
$entry = if (Test-Path $installed) { $installed } elseif (Test-Path $local) { $local } else {
  throw "no mcp/mcp.mjs in profile '$Profile' or in $Repo; install the plugin first or point -Repo at the clone"
}

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
& claude @cliArgs
if ($LASTEXITCODE -ne 0) { throw "claude mcp add failed with exit code $LASTEXITCODE" }
Write-Host 'Registered. Restart Claude Code, then ask it to call dsh_list.'
