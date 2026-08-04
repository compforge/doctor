#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle_version="${DOCTOR_PACKAGE_BUNDLE_VERSION:-$(tr -d '[:space:]' < "$root_dir/package-bundles/VERSION")}"
output_dir="${1:-$root_dir/dist}"
if [[ $# -gt 0 ]]; then
  shift
fi
variant_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$variant_dir"
}
trap cleanup EXIT

DOCTOR_PACKAGE_BUNDLE_VERSION="$bundle_version" \
  bash "$root_dir/scripts/build-package-bundle.sh" amd64 "$variant_dir"
DOCTOR_PACKAGE_BUNDLE_VERSION="$bundle_version" \
  bash "$root_dir/scripts/build-package-bundle.sh" arm64 "$variant_dir"

variants=(
  "$variant_dir/doctor-packages-debian12-amd64-gdb.tar"
  "$variant_dir/doctor-packages-debian12-arm64-gdb.tar"
  "$@"
)
bun "$root_dir/scripts/build-package-set.ts" \
  "$bundle_version" \
  "$output_dir/doctor-packages-$bundle_version-debian12.tar" \
  "${variants[@]}"
