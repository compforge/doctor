import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { CommandContext } from "../command";
import {
  packArtifacts,
  resolveArchivePath,
  resolveDefaultReportPaths,
} from "../collect/output/archive";
import { writeTabbedReport } from "../collect/output/tabbed-report";
import type { ReportTab } from "../collect/output/tabbed-report";
import { terminalStderr, terminalStdout } from "../terminal/output";
import { writeBundleAgents } from "./bundle-agents";

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
): Promise<boolean> {
  const artifacts = commandContext.artifacts.list();
  if (!artifacts.length) return true;
  if (commandCode === 130) {
    cleanupTemporaryArtifacts(artifacts.map((artifact) => artifact.path));
    return true;
  }

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

  if (needsHtml) {
    try {
      const reports = artifacts.filter((artifact) => existsSync(join(artifact.path, "report.html")));
      if (!reports.length) throw new Error("诊断产物缺少 report.html");
      if (reports.length === 1) {
        copyFileSync(join(reports[0]!.path, "report.html"), htmlOutputPath!);
      } else {
        const grouped = new Map<string, typeof reports>();
        for (const artifact of reports) {
          grouped.set(artifact.command, [...(grouped.get(artifact.command) ?? []), artifact]);
        }
        const tabs: ReportTab[] = [...grouped].map(([command, commandArtifacts]) =>
          commandArtifacts.length === 1
            ? {
                key: command,
                label: command,
                status: "delivered" as const,
                html: readFileSync(join(commandArtifacts[0]!.path, "report.html"), "utf8"),
              }
            : {
                key: command,
                label: command,
                status: "delivered" as const,
                tabs: commandArtifacts.map((artifact, index) => ({
                  key: `${command}-${index + 1}`,
                  label: basename(artifact.path),
                  status: "delivered" as const,
                  html: readFileSync(join(artifact.path, "report.html"), "utf8"),
                })),
              },
        );
        writeTabbedReport(htmlOutputPath!, {
          title: commandName ?? "doctor diagnosis",
          description: "由 Delivery 汇总各 command 的 HTML 诊断产物",
          ariaLabel: "诊断命令",
          tabs,
        });
      }
      chmodSync(htmlOutputPath!, 0o600);
      terminalStdout.success(`[delivery] HTML 报告: ${htmlOutputPath}\n`);
    } catch (error) {
      ok = false;
      terminalStderr.error(
        `[delivery] HTML 交付失败：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  if (fileFormat) {
    const seenCommands = new Set<string>();
    const sourceArtifacts = artifacts.filter((artifact) => {
      if (!existsSync(join(artifact.path, FORMAT_FILES[fileFormat])) || seenCommands.has(artifact.command)) return false;
      seenCommands.add(artifact.command);
      return true;
    });
    try {
      if (!sourceArtifacts.length) throw new Error(`诊断产物缺少 ${FORMAT_FILES[fileFormat]}`);
      if (sourceArtifacts.length === 1) {
        copyFileSync(join(sourceArtifacts[0]!.path, FORMAT_FILES[fileFormat]), fileOutputPath!);
      } else if (fileFormat === "md") {
        writeFileSync(fileOutputPath!, sourceArtifacts.map((artifact) =>
          `# ${artifact.command}\n\n${readFileSync(join(artifact.path, FORMAT_FILES.md), "utf8").trim()}\n`
        ).join("\n---\n\n"), "utf8");
      } else {
        const commands = Object.fromEntries(sourceArtifacts.map((artifact) => [
          artifact.command,
          JSON.parse(readFileSync(join(artifact.path, FORMAT_FILES.json), "utf8")),
        ]));
        writeFileSync(fileOutputPath!, `${JSON.stringify({ commands }, null, 2)}\n`, "utf8");
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
    try {
      agentsPath = writeBundleAgents({
        command: commandName ?? "doctor diagnosis",
        commandCode,
        artifacts,
      });
      packed = await packArtifacts(
        [...artifacts.map((artifact) => artifact.path), agentsPath],
        archivePath!,
      );
    } catch (error) {
      packed = { ok: false, exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    } finally {
      if (agentsPath) cleanupTemporaryArtifacts([agentsPath]);
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

  if (ok) cleanupTemporaryArtifacts(artifacts.map((artifact) => artifact.path));
  else terminalStderr.error(`[delivery] 原始产物保留在: ${artifacts.map((artifact) => artifact.path).join(", ")}\n`);
  return ok;
}
