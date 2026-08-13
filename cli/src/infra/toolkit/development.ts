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

function pydumpAsset(
  id: string,
  platform: { os: ToolkitOs; architecture: ToolkitArchitecture },
): string | undefined {
  const architecture = platformAssetArchitecture(platform.architecture);
  if (id === "pydump-analyzer") {
    return join(
      root,
      "assets",
      "pydump",
      `pydump_analyzer-0.1.0-${platform.os}-${architecture}.gz`,
    );
  }
  if (platform.os !== "linux") return undefined;
  if (id === "pydump-collector") {
    return join(root, "assets", "pydump", "pydump-0.1.0.pyz.gz");
  }
  const agent = /^pydump-agent-(3\.(?:10|11|12|13|14))-min-glibc-(2\.17)$/.exec(id);
  if (!agent) return undefined;
  const machine = architecture === "amd64" ? "x86_64" : "aarch64";
  return join(
    root,
    "assets",
    "pydump",
    `pydump-agent-${agent[1]}-min-glibc-${agent[2]}-${machine}.so.gz`,
  );
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
  const compressed = pydumpAsset(id, platform)
    ?? (id === "py-spy" && platform.os === "linux"
        ? join(
          root,
          "assets",
          "py-spy",
          `py-spy-0.4.2-${architecture === "amd64" ? "x86_64" : "aarch64"}.gz`,
        )
        : undefined);
  if (!compressed || !existsSync(compressed)) return undefined;
  const previous = extracted.get(compressed);
  if (previous) return previous;
  const output = join(
    extractionRoot(),
    id.startsWith("pydump-agent-")
      ? `${id}-${platform.architecture === "amd64" ? "x86_64" : "aarch64"}.so`
      : id,
  );
  writeFileSync(output, gunzipSync(readFileSync(compressed)), { mode: 0o700 });
  chmodSync(output, 0o700);
  extracted.set(compressed, output);
  return output;
}

process.once("exit", () => {
  if (extractedRoot) rmSync(extractedRoot, { recursive: true, force: true });
});
