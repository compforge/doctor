import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  packArchiveEntries,
  resolveArchivePath,
  resolveDefaultReportPaths,
} from "../collect/output/archive";
import type { CommandContext } from "../command";
import type { RenderContext } from "../report/context";
import { renderReportHtml } from "../report/html";
import type { Report } from "../report/model";
import { terminalStderr, terminalStdout } from "../terminal/output";
import { writeBundleAgents } from "./bundle-agents";
import { createBundleManifest, planBundleArtifacts } from "./bundle-layout";

export interface CommandDeliveryOptions {
  format?: string;
  output?: string;
}

type FileDeliveryFormat = "html" | "json" | "md";
type DeliveryFormat = "default" | FileDeliveryFormat | "bundle";

const DELIVERY_FORMATS: readonly DeliveryFormat[] = ["default", "html", "json", "md", "bundle"];

const FORMAT_FILES: Record<FileDeliveryFormat, string> = {
  html: "report.html",
  json: "diagnosis.json",
  md: "summary.md",
};

function resolveFileOutputPath(
  output: string | undefined,
  reportName: string,
  format: FileDeliveryFormat,
): string {
  const candidate = output?.trim() || reportName;
  return resolve(candidate.toLowerCase().endsWith(`.${format}`) ? candidate : `${candidate}.${format}`);
}

function assertOutputDoesNotExist(path: string): void {
  if (existsSync(path)) throw new Error(`--output 已存在，为避免覆盖请换一个路径：${path}`);
}

function resolveDeliveryFormat(value: string | undefined): DeliveryFormat {
  const format = value?.trim();
  if (!format) return "default";
  if (DELIVERY_FORMATS.includes(format as DeliveryFormat)) return format as DeliveryFormat;
  terminalStderr.warning(`[delivery] 未识别 format '${format}'，按 default 交付 HTML + Bundle\n`);
  return "default";
}

function timestamp(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function cleanupTemporaryArtifacts(paths: readonly string[]): void {
  const temporaryRoot = `${resolve(tmpdir())}${sep}`;
  for (const path of paths) {
    const absolutePath = resolve(path);
    if (!absolutePath.startsWith(temporaryRoot)) continue;
    rmSync(absolutePath, { recursive: true, force: true });
    const parent = dirname(absolutePath);
    if (!parent.startsWith(temporaryRoot) || !basename(parent).startsWith("doctor-")) continue;
    try {
      rmdirSync(parent);
    } catch {
      // Other artifacts may still share the same command-owned temporary parent.
    }
  }
}

/**
 * @rule A top-level command delivers all paths explicitly registered in its shared CommandContext once.
 * Nested commands only register artifacts; they never compress or clean them independently.
 */
export async function deliverCommandArtifacts(
  commandContext: CommandContext,
  options: CommandDeliveryOptions,
  commandCode: number,
  commandName?: string,
  rendered?: { report: Report; context: RenderContext; preserveArtifacts?: boolean },
): Promise<boolean> {
  const artifacts = commandContext.artifacts.list();
  if (!artifacts.length) return true;

  const commands = [...new Set(artifacts.map((artifact) => artifact.command))];
  const commandSlug = commandName?.replace(/^doctor\s+/, "").trim().replace(/\s+/g, "-");
  const reportName = commandContext.artifacts.reportName()
    ?? (commandSlug && (commands.length > 1 || commands[0] !== commandSlug)
      ? `doctor-${commandSlug}-${timestamp()}`
      : basename(artifacts[0]!.path));
  const format = resolveDeliveryFormat(options.format);
  const defaultPaths = resolveDefaultReportPaths(options.output, reportName);
  const fileFormat = format === "json" || format === "md"
    ? format
    : undefined;
  const needsHtml = format === "default" || format === "html";
  const needsBundle = format === "default" || format === "bundle";
  const htmlOutputPath = needsHtml
    ? format === "default"
      ? defaultPaths.html
      : resolveFileOutputPath(options.output, reportName, "html")
    : undefined;
  const fileOutputPath = fileFormat
    ? resolveFileOutputPath(options.output, reportName, fileFormat)
    : undefined;
  const archivePath = needsBundle
    ? format === "default"
      ? defaultPaths.bundle
      : resolveArchivePath(options.output, reportName)
    : undefined;
  try {
    for (const path of [htmlOutputPath, fileOutputPath, archivePath]) {
      if (path) assertOutputDoesNotExist(path);
    }
  } catch (error) {
    terminalStderr.error(`[delivery] ${error instanceof Error ? error.message : String(error)}\n`);
    terminalStderr.error(`[delivery] 原始产物保留在: ${artifacts.map((artifact) => artifact.path).join(", ")}\n`);
    return false;
  }
  let ok = true;

  let html: string | undefined;
  if ((needsHtml || needsBundle) && rendered?.report.sections.length) {
    try { html = renderReportHtml(rendered.report, rendered.context); }
    catch (error) {
      ok = false;
      terminalStderr.error(`[delivery] HTML 生成失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (needsHtml) {
    try {
      if (!html) throw new Error("Command 未提供可阅读的报告");
      writeFileSync(htmlOutputPath!, html, { mode: 0o600 });
      terminalStdout.success(`[delivery] HTML 报告: ${htmlOutputPath}\n`);
    } catch (error) {
      ok = false;
      terminalStderr.error(`[delivery] HTML 交付失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  if (fileFormat) {
    // Identity was resolved by CommandArtifacts. A command can produce many independent artifacts.
    const sourceArtifacts = artifacts.filter(artifact => existsSync(join(artifact.path, FORMAT_FILES[fileFormat])));
    try {
      if (!sourceArtifacts.length) throw new Error(`诊断产物缺少 ${FORMAT_FILES[fileFormat]}`);
      if (sourceArtifacts.length === 1) {
        copyFileSync(join(sourceArtifacts[0]!.path, FORMAT_FILES[fileFormat]), fileOutputPath!);
      } else if (fileFormat === "md") {
        writeFileSync(fileOutputPath!, sourceArtifacts.map((artifact) =>
          `# ${artifact.command} (${artifact.id})\n\n${readFileSync(join(artifact.path, FORMAT_FILES.md), "utf8").trim()}\n`
        ).join("\n---\n\n"), "utf8");
      } else {
        const entries = sourceArtifacts.map(artifact => ({
          id: artifact.id,
          command: artifact.command,
          diagnosis: JSON.parse(readFileSync(join(artifact.path, FORMAT_FILES.json), "utf8")),
        }));
        writeFileSync(fileOutputPath!, `${JSON.stringify({ artifacts: entries }, null, 2)}\n`, "utf8");
      }
      chmodSync(fileOutputPath!, 0o600);
      terminalStdout.success(`[delivery] ${fileFormat.toUpperCase()} 报告: ${fileOutputPath}\n`);
    } catch (error) {
      ok = false;
      terminalStderr.error(
        `[delivery] ${fileFormat.toUpperCase()} 交付失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  if (needsBundle) {
    let packed;
    let agentsPath: string | undefined;
    let indexDirectory: string | undefined;
    try {
      const layout = planBundleArtifacts(artifacts);
      indexDirectory = mkdtempSync(join(tmpdir(), "doctor-delivery-index-"));
      const indexPath = join(indexDirectory, "manifest.json");
      writeFileSync(indexPath, `${JSON.stringify(createBundleManifest(commandName ?? "doctor diagnosis", commandCode, layout, html ? "report.html" : undefined), null, 2)}\n`, { mode: 0o600 });
      agentsPath = writeBundleAgents({
        command: commandName ?? "doctor diagnosis",
        commandCode,
        artifacts: layout,
        report: html ? "report.html" : undefined,
      });
      const reportPath = join(indexDirectory, "report.html");
      if (html) writeFileSync(reportPath, html, { mode: 0o600 });
      packed = await packArchiveEntries(
        [...layout.map(({ artifact, path }) => ({ source: artifact.path, path })),
          { source: indexPath, path: "manifest.json" }, { source: agentsPath, path: "AGENTS.md" },
          ...(html ? [{ source: reportPath, path: "report.html" }] : [])],
        archivePath!,
      );
    } catch (error) {
      packed = { ok: false, exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    } finally {
      if (agentsPath) cleanupTemporaryArtifacts([agentsPath]);
      if (indexDirectory) cleanupTemporaryArtifacts([indexDirectory]);
    }
    if (packed.ok) {
      chmodSync(archivePath!, 0o600);
      terminalStdout.result(commandCode === 0, `[delivery] Evidence Bundle: ${archivePath}\n`);
    }
    else {
      ok = false;
      terminalStderr.error(`[delivery] Bundle 打包失败：${packed.stderr.trim().split("\n")[0]}\n`);
    }
  }

  if (ok && !rendered?.preserveArtifacts) cleanupTemporaryArtifacts(artifacts.map((artifact) => artifact.path));
  else terminalStderr.error(`[delivery] 原始产物保留在: ${artifacts.map((artifact) => artifact.path).join(", ")}\n`);
  return ok;
}
