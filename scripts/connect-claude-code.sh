#!/usr/bin/env sh
# Print or run the `claude mcp add` command for this installation.
# Prefers the plugin installed in a DSH profile; falls back to this clone.
# The config contains no token: the MCP client reads the URL and token from
# ~/.dsh/agent-bridge.json at run time.
#
# Usage: ./scripts/connect-claude-code.sh [agent-name] [--profile desktop] [--execute]
set -eu

agent=claude-code
profile=desktop
execute=false
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

while [ $# -gt 0 ]; do
  case "$1" in
    --execute) execute=true; shift ;;
    --profile|-p) profile=${2:?--profile needs a value}; shift 2 ;;
    --repo) repo=${2:?--repo needs a value}; shift 2 ;;
    -h|--help) echo 'usage: connect-claude-code.sh [agent-name] [--profile desktop] [--execute]'; exit 0 ;;
    *) agent="$1"; shift ;;
  esac
done

installed="$HOME/.dsh/profiles/$profile/node_modules/dsh-agent-bridge/mcp/mcp.mjs"
if [ -f "$installed" ]; then
  entry="$installed"
elif [ -f "$repo/mcp/mcp.mjs" ]; then
  entry="$repo/mcp/mcp.mjs"
else
  echo "no mcp/mcp.mjs in profile '$profile' or in $repo; install the plugin first" >&2
  exit 1
fi

echo "claude mcp add dsh-agent-bridge --env DSH_AGENT_NAME=$agent -- node \"$entry\""
if ! command -v claude >/dev/null 2>&1; then
  echo "the claude CLI is not on PATH; run the printed command yourself or install Claude Code first" >&2
  exit 1
fi
if [ "$execute" != true ]; then
  echo
  echo "Re-run with --execute to register it now."
  exit 0
fi
claude mcp add dsh-agent-bridge --env "DSH_AGENT_NAME=$agent" -- node "$entry"
echo "Registered. Restart Claude Code, then ask it to call dsh_list."
