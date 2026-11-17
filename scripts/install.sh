#!/usr/bin/env sh
# Install or update the DSH Agent Bridge plugin from this git clone.
# DSH caches plugin modules, so the change only takes effect after a restart.
# Usage: ./scripts/install.sh [profile]     (default profile: desktop)
set -eu

profile="${1:-desktop}"
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if ! command -v dsh >/dev/null 2>&1; then
  echo "the dsh CLI is not on PATH; run this from a shell that can call the dsh bundled with DeepSeek Harness" >&2
  exit 1
fi
if [ ! -f "$repo/package.json" ]; then
  echo "no package.json in $repo; run this from the dsh-agent-bridge clone" >&2
  exit 1
fi
version=$(node -p "require('$repo/package.json').version")
state="$HOME/.dsh/agent-bridge.json"
if [ -f "$state" ]; then
  echo "Keeping the existing token in $state."
fi

echo "Installing dsh-agent-bridge $version into profile '$profile'"
dsh plugin --profile "$profile" remove dsh-agent-bridge || true
dsh plugin --profile "$profile" add "file:$repo"

echo
echo "Restart DeepSeek Harness while no session is working, then verify the build:"
echo "  node scripts/health.mjs"
