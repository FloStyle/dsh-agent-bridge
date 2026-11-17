#!/usr/bin/env sh
# Install or upgrade dsh-agent-bridge in a DSH profile.
#
# Backs up the profile's package.json, pnpm-lock.yaml and cordis files, then adds
# the requested build. The new package is added before anything is removed: pnpm
# replaces the dependency in place, so a failed install cannot leave the profile
# without a bridge. On failure the backup is restored and the script exits
# non-zero. It never reads or prints the bridge token.
#
# Usage:
#   ./scripts/install.sh [--source release|github|local] [--version X.Y.Z]
#                        [--profile desktop] [--repo PATH]
#
# Default source is release (the GitHub tarball), default version is the latest
# release. Use --source local for development from this clone.
set -eu

source=release
version=''
profile=desktop
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
package_name=dsh-agent-bridge
repo_slug=FloStyle/dsh-agent-bridge

usage() {
  cat <<'EOF'
usage: install.sh [--source release|github|local] [--version X.Y.Z] [--profile desktop] [--repo PATH]
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source|-s) source=${2:?--source needs a value}; shift 2 ;;
    --version|-v) version=${2:?--version needs a value}; shift 2 ;;
    --profile|-p) profile=${2:?--profile needs a value}; shift 2 ;;
    --repo) repo=${2:?--repo needs a value}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$source" in
  release|github|local) ;;
  *) echo "--source must be release, github or local" >&2; exit 2 ;;
esac

latest_version() {
  curl -fsSL "https://api.github.com/repos/$repo_slug/releases/latest" \
    | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1
}

if [ -z "$version" ]; then
  if [ "$source" = local ]; then
    version=$(node -p "require('$repo/package.json').version")
  else
    version=$(latest_version)
    [ -n "$version" ] || { echo "could not read the latest release of $repo_slug; pass --version" >&2; exit 1; }
  fi
fi

spec=''
case "$source" in
  release) spec="https://github.com/$repo_slug/releases/download/v$version/$package_name-$version.tgz" ;;
  github) spec="github:$repo_slug#v$version" ;;
  local) spec="file:$repo" ;;
esac

command -v dsh >/dev/null 2>&1 || { echo 'the dsh CLI is not on PATH; use the dsh bundled with DeepSeek Harness' >&2; exit 1; }

profile_dir="$HOME/.dsh/profiles/$profile"
backup_dir="$HOME/.dsh/backups/$profile-$(date +%Y%m%d-%H%M%S)"
backup_files="package.json pnpm-lock.yaml cordis.yml cordis.patch.yml"
restored_files=''

if [ -d "$profile_dir" ]; then
  mkdir -p "$backup_dir"
  for file in $backup_files; do
    if [ -f "$profile_dir/$file" ]; then
      cp -p "$profile_dir/$file" "$backup_dir/$file"
      restored_files="$restored_files $file"
    fi
  done
  set -- $restored_files
  echo "Backed up $# file(s) to $backup_dir"
else
  echo "Profile '$profile' does not exist yet; dsh initializes it on first add."
fi

restore_backup() {
  [ -d "$backup_dir" ] || return 0
  for file in $restored_files; do cp -p "$backup_dir/$file" "$profile_dir/$file"; done
  echo "Restored the previous profile files from $backup_dir"
}

echo "Installing $package_name $version from $source into profile '$profile'"
echo "  $spec"
if ! dsh plugin --profile "$profile" add "$spec"; then
  restore_backup
  echo "dsh plugin add failed; the profile was restored" >&2
  exit 1
fi

manifest="$profile_dir/package.json"
installed='not found'
if [ -f "$profile_dir/node_modules/$package_name/package.json" ]; then
  installed=$(node -p "require('$profile_dir/node_modules/$package_name/package.json').version")
fi

# Enablement check (I4): DSH may or may not add the bundle itself.
bundle_state=unknown
if [ -f "$manifest" ]; then
  bundle_state='unknown'
  if node -e '
const fs = require("fs")
const [file, name] = process.argv.slice(1)
const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []
if (pkg.dsh.profile.bundles.includes(name)) process.exit(0)
pkg.dsh.profile.bundles.push(name)
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n")
process.exit(10)
' "$manifest" "$package_name"; then
    bundle_state='dsh added it'
  else
    code=$?
    if [ "$code" -eq 10 ]; then bundle_state='added by this script'; fi
  fi
fi

echo
echo "Installed $package_name $version into profile '$profile'"
echo "  installed version: $installed"
echo "  dsh.profile.bundles: $bundle_state"
echo
echo 'Restart DeepSeek Harness while no session is working, then check:'
echo '  node scripts/doctor.mjs'
echo 'Rollback:'
[ -d "$backup_dir" ] && echo "  copy $backup_dir/* back to $profile_dir and restart DSH"
