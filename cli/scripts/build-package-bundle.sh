#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
architecture="${1:?usage: build-package-bundle.sh <amd64|arm64> [output-dir]}"
output_dir="${2:-$root_dir/dist}"
engine="${DOCTOR_CONTAINER_ENGINE:-}"
bundle_version="${DOCTOR_PACKAGE_BUNDLE_VERSION:-$(tr -d '[:space:]' < "$root_dir/package-bundles/VERSION")}"
gdb_version="${DOCTOR_GDB_VERSION:-17.2}"
gdb_sha256="${DOCTOR_GDB_SHA256:-1c036c0d72e4b3d1fb5c94c88632add6f9d76f4d7c4d2ea793c12a9f19a3228c}"
gdb_build_jobs="${DOCTOR_GDB_BUILD_JOBS:-8}"

if [[ -z "$engine" ]]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    engine="docker"
  elif command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    engine="podman"
  else
    echo "Docker or Podman is required to build package bundles" >&2
    exit 1
  fi
fi
if [[ "$engine" != "docker" && "$engine" != "podman" ]]; then
  echo "unsupported DOCTOR_CONTAINER_ENGINE: $engine" >&2
  exit 1
fi
if [[ ! "$architecture" =~ ^(amd64|arm64)$ ]]; then
  echo "unsupported architecture: $architecture" >&2
  exit 1
fi
if [[ ! "$bundle_version" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]]; then
  echo "invalid DOCTOR_PACKAGE_BUNDLE_VERSION: $bundle_version" >&2
  exit 1
fi

mkdir -p "$output_dir"
tag="doctor-package-bundle:$bundle_version-gdb-debian12-$architecture"
container_id=""
copy_archive=""
cleanup() {
  if [[ -n "$copy_archive" ]]; then
    rm -f "$copy_archive"
  fi
  if [[ -n "$container_id" ]]; then
    "$engine" rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  "$engine" rmi -f "$tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT

build_args=(
  build
  --platform "linux/$architecture"
  --build-arg "DEBIAN_VERSION=12"
  --build-arg "GDB_VERSION=$gdb_version"
  --build-arg "GDB_SHA256=$gdb_sha256"
  --build-arg "GDB_BUILD_JOBS=$gdb_build_jobs"
  --build-arg "PACKAGE_NAMES=gdb"
  --build-arg "DOCTOR_PACKAGE_BUNDLE_VERSION=$bundle_version"
  --build-arg "DOCTOR_KERNEL_MIN_INCLUSIVE=${DOCTOR_KERNEL_MIN_INCLUSIVE:-}"
  --build-arg "DOCTOR_KERNEL_MAX_EXCLUSIVE=${DOCTOR_KERNEL_MAX_EXCLUSIVE:-}"
)
for proxy_name in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
  proxy_value="${!proxy_name:-}"
  if [[ -n "$proxy_value" ]]; then
    build_args+=(--build-arg "$proxy_name=$proxy_value")
  fi
done
build_args+=(
  --tag "$tag"
  -f package-bundles/debian/Dockerfile
  .
)
if [[ "$engine" == "docker" ]]; then
  build_args=(buildx "${build_args[@]}" --load)
fi

(
  cd "$root_dir"
  "$engine" "${build_args[@]}"
)
# The export image is scratch and has no default command; create only needs a placeholder for cp.
container_id="$("$engine" create "$tag" /bin/true)"
copy_archive="$(mktemp)"
"$engine" cp "$container_id:/out/." - > "$copy_archive"
tar -xf "$copy_archive" -C "$output_dir"
echo "package bundle copied to: $output_dir"
