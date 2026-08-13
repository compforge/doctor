#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <pydump-source-root>" >&2
  exit 1
fi

source_root=$(cd "$1" && pwd)
toolkit_root=$(cd "$(dirname "$0")/.." && pwd)
asset_root="$toolkit_root/assets/pydump"
revision=$(tr -d '[:space:]' < "$asset_root/REVISION")
version=0.1.0
builder=${PYDUMP_BUILDER:-}
builder_args=()
if [[ -n "$builder" ]]; then
  builder_args=(--builder "$builder")
fi
python_base_image_prefix=${PYDUMP_PYTHON_BASE_IMAGE_PREFIX:-}
build_base_image=${PYDUMP_BUILD_BASE_IMAGE:-}
proxy_args=()
for name in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY; do
  if [[ -n "${!name:-}" ]]; then
    proxy_args+=(--build-arg "$name=${!name}")
  fi
done

if ! actual_revision=$(git -C "$source_root" rev-parse HEAD 2>/dev/null); then
  echo "pydump source root must be a git checkout: $source_root" >&2
  exit 1
fi
if [[ "$actual_revision" != "$revision" ]]; then
  echo "pydump source revision mismatch: expected $revision, got $actual_revision" >&2
  exit 1
fi

mkdir -p "$asset_root"
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

python3 -m zipapp "$source_root/capture/collector/src" \
  -m pydump.cli:main \
  -p '/usr/bin/env python3' \
  -o "$temporary/pydump"
gzip -n -9 -c "$temporary/pydump" > "$asset_root/pydump-$version.pyz.gz"

for platform in darwin/amd64 darwin/arm64 linux/amd64 linux/arm64; do
  os=${platform%/*}
  arch=${platform#*/}
  output="$temporary/analyzer-$os-$arch"
  mkdir -p "$output"
  docker buildx build "${builder_args[@]}" \
    --platform "$os/$arch" \
    --output "type=local,dest=$output" \
    -f "$toolkit_root/scripts/pydump-analyzer.Dockerfile" \
    "$source_root"
  gzip -n -9 -c "$output/pydump_analyzer" \
    > "$asset_root/pydump_analyzer-$version-$os-$arch.gz"
done

for platform in linux/amd64 linux/arm64; do
  arch=${platform#*/}
  case "$arch" in
    amd64) machine=x86_64 ;;
    arm64) machine=aarch64 ;;
  esac
  for minor in 3.10 3.11 3.12 3.13 3.14; do
    output="$temporary/agent-$minor-$arch"
    mkdir -p "$output"
    agent_build_args=(--build-arg PYTHON_VERSION="$minor")
    if [[ -n "$python_base_image_prefix" ]]; then
      agent_build_args+=(
        --build-arg "PYTHON_BASE_IMAGE=${python_base_image_prefix}python:$minor-slim-bookworm"
      )
    fi
    if [[ -n "$build_base_image" ]]; then
      agent_build_args+=(--build-arg "BUILD_BASE_IMAGE=$build_base_image")
    fi
    docker buildx build "${builder_args[@]}" "${proxy_args[@]}" \
      --platform "$platform" \
      "${agent_build_args[@]}" \
      --output "type=local,dest=$output" \
      -f "$toolkit_root/scripts/pydump-agent.Dockerfile" \
      "$source_root"
    gzip -n -9 -c "$output/pydump-agent.so" \
      > "$asset_root/pydump-agent-$minor-min-glibc-2.17-$machine.so.gz"
  done
done

cp "$source_root/LICENSE" "$asset_root/pydump-LICENSE.txt"
cp "$source_root/NOTICE" "$asset_root/pydump-NOTICE.txt"
