#!/usr/bin/env sh
# Remove dsh-agent-bridge from a DSH profile.
#
# Removes the package and its dsh.profile.bundles entry. The private state file
# (~/.dsh/agent-bridge.json) and the audit log are kept unless you confirm their
# removal, or pass --purge. Tokens are never printed.
#
# Usage: ./scripts/uninstall.sh [--profile desktop] [--purge]
set -eu

profile=desktop
purge=false
package_name=dsh-agent-bridge

while [ $# -gt 0 ]; do
  case "$1" in
    --profile|-p) profile=${2:?--profile needs a value}; shift 2 ;;
    --purge) purge=true; shift ;;
    -h|--help) echo 'usage: uninstall.sh [--profile desktop] [--purge]'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v dsh >/dev/null 2>&1 || { echo 'the dsh CLI is not on PATH; use the dsh bundled with DeepSeek Harness' >&2; exit 1; }

profile_dir="$HOME/.dsh/profiles/$profile"
state_file="$HOME/.dsh/agent-bridge.json"
audit_file="$HOME/.dsh/agent-bridge-audit.jsonl"

echo "Removing $package_name from profile '$profile'"
dsh plugin --profile "$profile" remove "$package_name" || echo "dsh plugin remove failed; the package may already be absent" >&2

manifest="$profile_dir/package.json"
if [ -f "$manifest" ]; then
  node -e '
const fs = require("fs")
const [file, name] = process.argv.slice(1)
const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
const bundles = pkg?.dsh?.profile?.bundles
if (Array.isArray(bundles) && bundles.includes(name)) {
  pkg.dsh.profile.bundles = bundles.filter((entry) => entry !== name)
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
  console.log(`Removed ${name} from dsh.profile.bundles`)
}
' "$manifest" "$package_name"
fi

private_files=''
for file in "$state_file" "$audit_file" "$audit_file.1"; do
  [ -f "$file" ] && private_files="$private_files $file"
done

if [ -z "$private_files" ]; then
  echo 'No private bridge files to remove.'
else
  answer=n
  if [ "$purge" = true ]; then
    answer=y
  else
    echo 'Private files that can be deleted:'
    for file in $private_files; do echo "  $file"; done
    printf 'Delete them? They hold the bridge token and audit history [y/N] '
    read -r answer || answer=n
  fi
  case "$answer" in
    y|Y|yes|YES)
      for file in $private_files; do rm -f "$file"; echo "Deleted $file"; done ;;
    *)
      echo 'Kept the private bridge files.' ;;
  esac
fi

echo
echo 'Restart DeepSeek Harness to unload the plugin.'
