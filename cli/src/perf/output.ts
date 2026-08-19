import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packReportBundle, resolveArchivePath } from "../collect/output/archive";
import type { ExecResult } from "../infra/k8s/executor";
import type { PerfConfig } from "./model";

export interface PreparedPerfOutput {
  outputDir: string;
  archivePath?: string;
  temporaryRoot?: string;
}

export function preparePerfOutput(config: PerfConfig): PreparedPerfOutput {
  const archivePath = config.outputFormat === "bundle" || config.outputFormat === "default"
    ? resolve(resolveArchivePath(config.outputDir, config.bundleName))
    : undefined;
  if (archivePath && existsSync(archivePath)) {
    throw new Error(`--output 已存在，为避免覆盖请换一个路径：${archivePath}`);
  }
  const temporaryRoot = config.outputFormat === "bundle"
    ? mkdtempSync(join(tmpdir(), "doctor-perf-"))
    : undefined;
  const outputDir = temporaryRoot ? join(temporaryRoot, config.bundleName) : resolve(config.outputDir);
  if (existsSync(outputDir)) {
    throw new Error(`--output 已存在，为避免覆盖请换一个目录：${outputDir}`);
  }
  mkdirSync(outputDir, { recursive: true });
  return { outputDir, archivePath, temporaryRoot };
}

export async function deliverPerfBundle(output: PreparedPerfOutput): Promise<ExecResult | undefined> {
  if (!output.archivePath) return undefined;
  const packed = await packReportBundle(output.outputDir, output.archivePath);
  if (packed.ok && output.temporaryRoot) rmSync(output.temporaryRoot, { recursive: true, force: true });
  return packed;
}
