#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
architecture="${1:?usage: build-package-set.sh <amd64|arm64> [output-dir]}"
output_dir="${2:-$root_dir/dist}"
bundle_version="${DOCTOR_TOOLKIT_VERSION:-$(tr -d '[:space:]' < "$root_dir/VERSION")}"
temporary_root="$(mktemp -d)"
cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

variants=(
  "gdb-13.1|13.1|115ad5c18d69a6be2ab15882d365dda2a2211c14f480b3502c6eba576e2e95a0|1:13.1-doctor1"
  "gdb-17.2|17.2|1c036c0d72e4b3d1fb5c94c88632add6f9d76f4d7c4d2ea793c12a9f19a3228c|1:17.2-doctor1"
)

if bun "$root_dir/scripts/reuse-package-set.ts" \
    "$bundle_version" \
    "$architecture" \
    "$output_dir/doctor-packages-$bundle_version-gdb-linux-$architecture.tar" \
    "${variants[@]}"; then
  exit 0
fi

build_variant() {
  local id="$1"
  local version="$2"
  local sha256="$3"
  local variant_dir="$temporary_root/$id"
  mkdir -p "$variant_dir"
  DOCTOR_TOOLKIT_VERSION="$bundle_version" \
    DOCTOR_GDB_VERSION="$version" \
    DOCTOR_GDB_SHA256="$sha256" \
    DOCTOR_GDB_BUILD_JOBS="${DOCTOR_GDB_BUILD_JOBS:-8}" \
    bash "$root_dir/scripts/build-package-bundle.sh" "$architecture" "$variant_dir"
}

variant_args=()
for variant in "${variants[@]}"; do
  IFS='|' read -r id version sha256 _ <<< "$variant"
  build_variant "$id" "$version" "$sha256"
  variant_args+=("$id=$temporary_root/$id/doctor-packages-debian12-$architecture-gdb.tar")
done

mkdir -p "$output_dir"
bun "$root_dir/scripts/build-package-set.ts" \
  "$bundle_version" \
  "$output_dir/doctor-packages-$bundle_version-gdb-linux-$architecture.tar" \
  "${variant_args[@]}"
