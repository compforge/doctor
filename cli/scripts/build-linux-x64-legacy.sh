#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-$ROOT_DIR/dist/doctor-linux-x64-kernel-3.10-glibc-2.17}"
DOCTOR_ENTRY="${DOCTOR_ENTRY:-$ROOT_DIR/src/app/entry.ts}"
WORK_DIR="$ROOT_DIR/dist/.linux-x64-legacy"
NODE_VERSION="22.23.1"
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64-glibc-217.tar.xz"
NODE_SHA256="2e729bf3198098a221681d3f1926a2d505c020a683d3b8e4826e3794818da340"
NODE_URL="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/${NODE_ARCHIVE}"
BUILD_NODE="$ROOT_DIR/node_modules/node/bin/node"
POSTJECT="$ROOT_DIR/node_modules/.bin/postject"

if [[ "$($BUILD_NODE --version)" != "v${NODE_VERSION}" ]]; then
  echo "legacy build requires node v${NODE_VERSION} from devDependencies" >&2
  exit 1
fi

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/core" "$(dirname "$OUTPUT")"
trap 'rm -rf "$WORK_DIR"' EXIT

bun build "$DOCTOR_ENTRY" \
  --target=node \
  --format=esm \
  --outdir="$WORK_DIR/core" \
  --entry-naming=doctor-core.mjs \
  --define 'import.meta.url="file:///__doctor_sea__/doctor-core.mjs"'

# Node 22.20+ can execute an ESM SEA main directly. Keeping the bundle as the main module
# avoids data-URL stack traces that dump the entire Base64-encoded CLI on startup errors.
cat > "$WORK_DIR/sea-config.json" <<EOF
{
  "main": "$WORK_DIR/core/doctor-core.mjs",
  "mainFormat": "module",
  "output": "$WORK_DIR/doctor.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false
}
EOF

"$BUILD_NODE" --experimental-sea-config "$WORK_DIR/sea-config.json"

archive_path="$WORK_DIR/$NODE_ARCHIVE"
curl --fail --location --silent --show-error "$NODE_URL" --output "$archive_path"
"$BUILD_NODE" -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  const [path, expected] = process.argv.slice(1);
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expected) throw new Error(`Node runtime checksum mismatch: ${actual}`);
' "$archive_path" "$NODE_SHA256"

tar -xJf "$archive_path" -C "$WORK_DIR" "node-v${NODE_VERSION}-linux-x64-glibc-217/bin/node"
cp "$WORK_DIR/node-v${NODE_VERSION}-linux-x64-glibc-217/bin/node" "$OUTPUT"
"$POSTJECT" "$OUTPUT" NODE_SEA_BLOB "$WORK_DIR/doctor.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
chmod 755 "$OUTPUT"

echo "built: $OUTPUT"
