import { terminalStderr } from "../terminal/output";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DOCTOR_CLI_VERSION } from "./version";

const processStartedAt = new Date();

interface ErrorLogWriteResult {
  path: string;
  failure?: unknown;
}

export interface ReportErrorOptions {
  /** 稳定操作名，不放用户参数或凭据。 */
  context: string;
  summary?: string;
  displayMessage?: string;
  plugin?: string;
}

function timestampForFilename(date: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    part(date.getMonth() + 1),
    part(date.getDate()),
    "-",
    part(date.getHours()),
    part(date.getMinutes()),
    part(date.getSeconds()),
  ].join("");
}

export function resolveErrorLogPath(): string {
  const configured = process.env.DOCTOR_ERROR_LOG?.trim();
  if (!configured) return resolve(`doctor-error-${timestampForFilename(processStartedAt)}.log`);
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

function errorDetail(error: unknown, seen = new Set<unknown>()): string {
  if (seen.has(error)) return "[circular error cause]";
  if (error instanceof Error) {
    seen.add(error);
    let detail = error.stack || `${error.name}: ${error.message}`;
    if (error.cause !== undefined) detail += `\nCaused by:\n${errorDetail(error.cause, seen)}`;
    if (error instanceof AggregateError && error.errors.length > 0) {
      detail += error.errors
        .map((item, index) => `\nAggregate error ${index + 1}:\n${errorDetail(item, seen)}`)
        .join("");
    }
    return detail;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandName(context: string): string {
  const candidate = context.match(/^doctor ([a-z][a-z0-9-]*)(?:[ /]|$)/i)?.[1];
  return candidate && candidate !== "main" && candidate !== "runtime" ? candidate : "root";
}

function runtimeName(): string {
  const bun = process.versions.bun;
  return bun ? `bun ${bun}` : `node ${process.version}`;
}

function debugEnabled(): boolean {
  const configured = process.env.DOCTOR_DEBUG?.trim().toLowerCase();
  if (configured && !["0", "false", "off", "no"].includes(configured)) return true;
  return process.argv.slice(2).some((argument) => argument === "--debug");
}

function writeErrorLogResult(
  error: unknown,
  context: string,
  plugin?: string,
): ErrorLogWriteResult {
  const path = resolveErrorLogPath();
  const entry = [
    `\n[${new Date().toISOString()}] doctor ${DOCTOR_CLI_VERSION}`,
    `command: ${commandName(context)}`,
    `context: ${context}`,
    `plugin: ${plugin ?? "unknown"}`,
    `runtime: ${runtimeName()}`,
    `platform: ${process.platform}-${process.arch}`,
    `pid: ${process.pid}`,
    `cwd: ${process.cwd()}`,
    `uptime_ms: ${Math.round(process.uptime() * 1_000)}`,
    "error:",
    errorDetail(error),
    "",
  ].join("\n");
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, entry, { encoding: "utf-8", mode: 0o600 });
    return { path };
  } catch (failure) {
    return { path, failure };
  }
}

function printErrorLogFallback(error: unknown, result: ErrorLogWriteResult): void {
  terminalStderr.warning(
    `[doctor] 无法写入错误日志 ${result.path}: ${errorMessage(result.failure)}\n`,
  );
  terminalStderr.error(`[doctor] 技术详情:\n${errorDetail(error)}\n`);
}

/**
 * 追加完整错误详情。记录 command 名但不记录 argv，避免 URL、密码等参数进入日志。
 * 日志本身是旁路诊断能力，写入失败不能掩盖原始异常。
 */
export function writeErrorLog(
  error: unknown,
  context: string,
  plugin?: string,
): string | undefined {
  const result = writeErrorLogResult(error, context, plugin);
  if (result.failure === undefined) return result.path;
  printErrorLogFallback(error, result);
  return undefined;
}

/** 终端展示给现场用户看的摘要；stack 与运行上下文进入 error log。日志不可写时回退到 stderr。 */
export function reportError(error: unknown, options: ReportErrorOptions): string | undefined {
  const result = writeErrorLogResult(error, options.context, options.plugin);
  const summary = options.summary ?? "error";
  const message = options.displayMessage ?? errorMessage(error);
  terminalStderr.error(`${summary}: ${message}\n`);
  terminalStderr.info(
    `[doctor] 版本 ${DOCTOR_CLI_VERSION}`
    + `${options.plugin ? `；Plugin ${options.plugin}` : ""}`
    + `；命令 ${commandName(options.context)}；阶段 ${options.context}\n`,
  );
  if (result.failure === undefined) {
    terminalStderr.info(`[doctor] 技术详情: ${result.path}\n`);
    if (debugEnabled()) terminalStderr.error(`[doctor] debug:\n${errorDetail(error)}\n`);
    return result.path;
  }
  printErrorLogFallback(error, result);
  return undefined;
}
