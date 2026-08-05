import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExecResult } from "../../infra/k8s/executor";
import { packBundle, resolveArchivePath } from "./archive";

interface ManifestStep {
  id?: string;
  status?: string;
  reason?: string;
  raw_file?: string;
}

interface EvidenceManifest {
  steps?: ManifestStep[];
}

export interface FailureBundleDelivery {
  path: string;
  packed: ExecResult;
}

/** 成功产物后缀不应泄漏到失败 Bundle 名称中，例如 report.html → report.tar.gz。 */
export function resolveFailureBundlePath(output: string | undefined, bundleName: string): string {
  if (!output) return resolveArchivePath(undefined, bundleName);
  if (output.endsWith(".tar.gz") || output.endsWith(".tgz")) return output;
  const suffix = [".html", ".md", ".json", ".pyheap"].find((item) => output.endsWith(item));
  return `${suffix ? output.slice(0, -suffix.length) : output}.tar.gz`;
}

function failureLog(bundleDir: string, collectCode: number, reason?: string): string {
  const lines = [`collect_exit_code=${collectCode}`, ...(reason ? [`reason=${reason}`] : [])];
  try {
    const manifest = JSON.parse(readFileSync(resolve(bundleDir, "manifest.json"), "utf-8")) as EvidenceManifest;
    const incomplete = (manifest.steps ?? []).filter((step) =>
      step.status === "partial" || step.status === "failed" || step.status === "unavailable"
    );
    if (incomplete.length) {
      lines.push("", "incomplete_steps:");
      for (const step of incomplete) {
        lines.push(
          `- ${step.id ?? "unknown"} [${step.status ?? "unknown"}]`
          + `${step.reason ? `: ${step.reason}` : ""}`
          + `${step.raw_file ? ` (raw=${step.raw_file})` : ""}`,
        );
      }
    }
  } catch (error) {
    lines.push("", `manifest_read_error=${error instanceof Error ? error.message : String(error)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Collect 失败的统一交付入口：任何成功 format 都降级为可回传的 Evidence Bundle。 */
export async function deliverFailureBundle(input: {
  bundleDir: string;
  bundleName: string;
  requestedOutput?: string;
  collectCode: number;
  reason?: string;
}): Promise<FailureBundleDelivery> {
  writeFileSync(
    resolve(input.bundleDir, "error.log"),
    failureLog(input.bundleDir, input.collectCode, input.reason),
    { mode: 0o600 },
  );
  const path = resolveFailureBundlePath(input.requestedOutput, input.bundleName);
  return { path, packed: await packBundle(input.bundleDir, path) };
}
