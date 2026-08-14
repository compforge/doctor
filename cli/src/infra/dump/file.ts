const FILE_METADATA_SCRIPT = String.raw`
import hashlib
import os
import sys

path = sys.argv[1]
digest = hashlib.sha256()
with open(path, "rb") as f:
    while chunk := f.read(1 << 20):
        digest.update(chunk)
print(os.path.getsize(path), digest.hexdigest())
`;

export function fileMetadataCmd(path: string): string[] {
  return ["python3", "-c", FILE_METADATA_SCRIPT, path];
}

export interface FileMetadata {
  bytes: number;
  sha256: string;
}

export function parseFileMetadata(output: string): FileMetadata | undefined {
  const match = output.trim().match(/^(\d+)\s+([a-f0-9]{64})$/);
  if (!match) return undefined;
  const bytes = Number(match[1]);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return undefined;
  return { bytes, sha256: match[2]! };
}

const COMPRESS_FILE_SCRIPT = String.raw`
import hashlib
import os
import sys
import zlib

src, dst = sys.argv[1], sys.argv[2]
compressor = zlib.compressobj(6, zlib.DEFLATED, 31)
digest = hashlib.sha256()
with open(src, "rb") as fin, open(dst, "wb") as fout:
    while True:
        chunk = fin.read(1 << 20)
        if not chunk:
            break
        compressed = compressor.compress(chunk)
        fout.write(compressed)
        digest.update(compressed)
    compressed = compressor.flush()
    fout.write(compressed)
    digest.update(compressed)
print(os.path.getsize(dst), digest.hexdigest())
`;

export function compressFileCmd(src: string, dst: string): string[] {
  return ["python3", "-c", COMPRESS_FILE_SCRIPT, src, dst];
}
