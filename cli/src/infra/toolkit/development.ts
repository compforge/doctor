import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { ToolkitArchitecture, ToolkitOs } from "./model";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../toolkit");
let extractedRoot: string | undefined;
const extracted = new Map<string, string>();

function extractionRoot(): string {
  extractedRoot ??= mkdtempSync(join(tmpdir(), "doctor-toolkit-source-"));
  return extractedRoot;
}

function platformAssetArchitecture(architecture: ToolkitArchitecture): string {
  return architecture;
}

/** Source-checkout fallback for development; release binaries never contain these files. */
export function resolveDevelopmentToolkitTool(
  id: string,
  platform: { os: ToolkitOs; architecture: ToolkitArchitecture },
): string | undefined {
  const architecture = platformAssetArchitecture(platform.architecture);
  const direct = id === "regctl"
    ? join(root, "assets", "regctl", `regctl-${platform.os}-${architecture}`)
    : undefined;
  if (direct && existsSync(direct)) return direct;
  const compressed = id === "pyheap-dumper"
    ? join(root, "assets", "pyheap", "pyheap_dump-0.7.0+doctor.2.gz")
    : id === "pyheap-analyzer"
      ? join(root, "assets", "pyheap", "pyheap_analyzer-0.7.0+doctor.2.gz")
      : id === "py-spy" && platform.os === "linux"
        ? join(
          root,
          "assets",
          "py-spy",
          `py-spy-0.4.2-${architecture === "amd64" ? "x86_64" : "aarch64"}.gz`,
        )
        : undefined;
  if (!compressed || !existsSync(compressed)) return undefined;
  const previous = extracted.get(compressed);
  if (previous) return previous;
  const output = join(extractionRoot(), id);
  writeFileSync(output, gunzipSync(readFileSync(compressed)), { mode: 0o700 });
  chmodSync(output, 0o700);
  extracted.set(compressed, output);
  return output;
}

process.once("exit", () => {
  if (extractedRoot) rmSync(extractedRoot, { recursive: true, force: true });
});
