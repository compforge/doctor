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
analyzer_version=0.1.0
builder=${PYDUMP_BUILDER:-}
builder_args=()
if [[ -n "$builder" ]]; then
  builder_args=(--builder "$builder")
fi

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
    > "$asset_root/pydump_analyzer-$analyzer_version-$os-$arch.gz"
done

cp "$source_root/LICENSE" "$asset_root/pydump-LICENSE.txt"
cp "$source_root/NOTICE" "$asset_root/pydump-NOTICE.txt"
