#!/usr/bin/env sh
# Print or run the `claude mcp add` command for this clone.
# Usage: ./scripts/connect-claude-code.sh [agent-name] [--execute]
set -eu

agent="${1:-claude-code}"
execute=false
for arg in "$@"; do
  [ "$arg" = "--execute" ] && execute=true
done
[ "$agent" = "--execute" ] && agent=claude-code

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
entry="$repo/mcp/mcp.mjs"
if [ ! -f "$entry" ]; then
  echo "no mcp/mcp.mjs in $repo; run this from the dsh-agent-bridge clone" >&2
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
