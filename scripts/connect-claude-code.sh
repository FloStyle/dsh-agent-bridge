#!/usr/bin/env sh
# Deprecated wrapper: dsh-bridge connect claude. Flags: --name, --profile, --execute.
echo "deprecated: use dsh-bridge connect claude" >&2
exec "$(dirname -- "$0")/../bin/dsh-bridge" connect claude "$@"
