#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-$ROOT_DIR/dist/doctor-kylin-arm64}"
DOCTOR_ENTRY="${DOCTOR_ENTRY:-$ROOT_DIR/src/app/entry.ts}"
WORK_DIR="$ROOT_DIR/dist/.linux-arm64-kylin"
NODE_VERSION="22.23.1"
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-arm64.tar.xz"
NODE_SHA256="0294e8b915ab75f92c7513d2fcb830ae06e10684e6c603e99a87dbf8835389c1"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
BUILD_NODE="$ROOT_DIR/node_modules/node/bin/node"
POSTJECT="$ROOT_DIR/node_modules/.bin/postject"

if [[ "$($BUILD_NODE --version)" != "v${NODE_VERSION}" ]]; then
  echo "Kylin ARM64 build requires node v${NODE_VERSION} from devDependencies" >&2
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

cat > "$WORK_DIR/bootstrap.cjs" <<'EOF'
const { getAsset } = require("node:sea");

const source = getAsset("doctor-core.mjs", "utf8");
const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
import(url).catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
EOF

cat > "$WORK_DIR/sea-config.json" <<EOF
{
  "main": "$WORK_DIR/bootstrap.cjs",
  "output": "$WORK_DIR/doctor.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false,
  "assets": {
    "doctor-core.mjs": "$WORK_DIR/core/doctor-core.mjs"
  }
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

tar -xJf "$archive_path" -C "$WORK_DIR" "node-v${NODE_VERSION}-linux-arm64/bin/node"
cp "$WORK_DIR/node-v${NODE_VERSION}-linux-arm64/bin/node" "$OUTPUT"
"$POSTJECT" "$OUTPUT" NODE_SEA_BLOB "$WORK_DIR/doctor.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
chmod 755 "$OUTPUT"

echo "built: $OUTPUT"
