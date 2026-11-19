#!/usr/bin/env sh
# Deprecated wrapper: dsh-bridge install. Same flags: --source, --version, --profile.
echo "deprecated: use dsh-bridge install" >&2
exec "$(dirname -- "$0")/../bin/dsh-bridge" install "$@"
