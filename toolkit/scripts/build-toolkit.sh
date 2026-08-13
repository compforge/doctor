#!/usr/bin/env bash
set -euo pipefail

toolkit_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:?usage: build-toolkit.sh <output.tar> <os/arch>...}"
shift
if [[ $# -eq 0 ]]; then
  echo "at least one os/arch platform is required" >&2
  exit 1
fi

stage_root="$(mktemp -d)"
cleanup() {
  rm -rf "$stage_root"
}
trap cleanup EXIT

for platform in "$@"; do
  os="${platform%/*}"
  architecture="${platform#*/}"
  make --no-print-directory -C "$toolkit_root" stage-platform \
    OS="$os" ARCH="$architecture" STAGE_ROOT="$stage_root"
done

bun "$toolkit_root/scripts/build-manifest.ts" \
  "$(tr -d '[:space:]' < "$toolkit_root/VERSION")" "$stage_root" "$output"
