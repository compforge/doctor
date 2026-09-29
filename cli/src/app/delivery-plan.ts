import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CommandInputError } from "../command/result";
import { resolveArchivePath, resolveDefaultReportPaths } from "../collect/output/archive";

export interface CommandDeliveryOptions { format?: string; output?: string }
export type DeliveryFormat = "default" | "html" | "json" | "md" | "summary" | "bundle" | "manifest";

/** Root-owned invocation snapshot. Collection and finalization never choose destinations. */
export interface DeliveryPlan {
  readonly format: DeliveryFormat;
  readonly needsHtml: boolean;
  readonly file?: Readonly<{ format: "html" | "json" | "md"; path: string }>;
  readonly archive?: string;
  readonly directory?: string;
}

export function createDeliveryPlan(command: string, options: CommandDeliveryOptions): DeliveryPlan {
  const format = options.format?.trim() || "default";
  if (!["default", "html", "json", "md", "summary", "bundle", "manifest"].includes(format)) {
    throw new CommandInputError(`未知 --format: '${format}'`);
  }
  const output = options.output?.trim();
  if (format === "summary" && output) {
    throw new CommandInputError("--format summary 直接输出到终端，不支持 --output");
  }
  const commandName = command.replace(/^doctor\s+/, "").replace(/[^a-zA-Z0-9_-]+/g, "-");
  const name = `doctor-${commandName}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const base = { format: format as DeliveryFormat, needsHtml: ["default", "html", "bundle"].includes(format) };
  if (format === "manifest") return Object.freeze({ ...base, directory: output ? resolve(output) : undefined });
  if (format === "summary") return Object.freeze(base);
  if (format === "bundle") return Object.freeze({ ...base, archive: resolve(resolveArchivePath(output, name)) });
  if (format === "default") {
    const paths = resolveDefaultReportPaths(output, name);
    return Object.freeze({ ...base, file: Object.freeze({ format: "html" as const, path: resolve(paths.html) }), archive: resolve(paths.bundle) });
  }
  const path = output || name;
  return Object.freeze({ ...base, file: Object.freeze({ format: format as "html" | "json" | "md",
    path: resolve(path.toLowerCase().endsWith(`.${format}`) ? path : `${path}.${format}`) }) });
}

/** Check all destinations before work and again before publication; publication still needs exclusive writes. */
export function assertDeliveryPathsAvailable(plan: DeliveryPlan): void {
  for (const path of [plan.file?.path, plan.archive, plan.directory]) {
    if (!path) continue;
    // A dangling symlink still occupies a name; existsSync would miss it.
    if (lstatSync(path, { throwIfNoEntry: false })) {
      throw new Error(`--output 已存在，为避免覆盖请换一个路径：${path}`);
    }
    const parent = dirname(path);
    if (!statSync(parent).isDirectory()) throw new Error(`输出父路径不是目录：${parent}`);
    accessSync(parent, constants.W_OK | constants.X_OK);
  }
}
