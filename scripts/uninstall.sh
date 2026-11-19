#!/usr/bin/env sh
# Deprecated wrapper: dsh-bridge uninstall. Same flags: --profile, --purge.
echo "deprecated: use dsh-bridge uninstall" >&2
exec "$(dirname -- "$0")/../bin/dsh-bridge" uninstall "$@"
