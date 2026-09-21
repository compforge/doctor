import { useLogger } from "../terminal/log";
import { DOCTOR_CLI_VERSION } from "./version";

export interface ReportErrorOptions {
  /** 稳定操作名，不放用户参数或凭据。 */
  context: string;
  summary?: string;
  displayMessage?: string;
  plugin?: string;
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

function debugEnabled(): boolean {
  const configured = process.env.DOCTOR_DEBUG?.trim().toLowerCase();
  if (configured && !["0", "false", "off", "no"].includes(configured)) return true;
  return process.argv.slice(2).some((argument) => argument === "--debug");
}

/** Print the error summary to stderr; full exception details require explicit debug mode. */
export function reportError(error: unknown, options: ReportErrorOptions): void {
  const summary = options.summary ?? "error";
  const message = options.displayMessage ?? errorMessage(error);
  useLogger().error(`${summary}: ${message}`);
  useLogger("doctor").error(`版本 ${DOCTOR_CLI_VERSION}`
    + `${options.plugin ? `；Plugin ${options.plugin}` : ""}`
    + `；命令 ${commandName(options.context)}；阶段 ${options.context}`);
  if (debugEnabled()) useLogger("doctor").error(`debug:\n${errorDetail(error)}`);
}
