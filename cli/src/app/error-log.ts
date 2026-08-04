import { terminalStderr } from "../terminal/output";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DOCTOR_CLI_VERSION } from "./version";

const processStartedAt = new Date();

export interface ReportErrorOptions {
  /** 稳定操作名，不放用户参数或凭据。 */
  context: string;
  summary?: string;
  displayMessage?: string;
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

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
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

/**
 * 追加完整错误详情。记录 command 名但不记录 argv，避免 URL、密码等参数进入日志。
 * 日志本身是旁路诊断能力，写入失败不能掩盖原始异常。
 */
export function writeErrorLog(error: unknown, context: string): string | undefined {
  const path = resolveErrorLogPath();
  const command = process.argv[2] || "root";
  const entry = [
    `\n[${new Date().toISOString()}] doctor ${DOCTOR_CLI_VERSION}`,
    `command: ${command}`,
    `context: ${context}`,
    errorDetail(error),
    "",
  ].join("\n");
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, entry, { encoding: "utf-8", mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

/** 终端只展示摘要；stack 等完整上下文统一进入 error log。 */
export function reportError(error: unknown, options: ReportErrorOptions): string | undefined {
  const path = writeErrorLog(error, options.context);
  const summary = options.summary ?? "error";
  const message = options.displayMessage ?? errorMessage(error);
  terminalStderr.error(`${summary}: ${message}\n`);
  if (path) terminalStderr.info(`[doctor] 错误详情: ${path}\n`);
  return path;
}
