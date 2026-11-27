import { DoctorError } from "@compforge/doctor-plugin";
import { ToolboxError } from "@compforge/harness-toolbox/errors";
import { CommandError } from "./result";

/** Credentials and signed URLs never belong in reusable diagnostic evidence. */
export function diagnosticMessage(error: unknown, secrets: readonly string[] = []): string {
  let text = error instanceof Error ? error.message : String(error);
  text = text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, raw => {
    try {
      const url = new URL(raw);
      url.username = ""; url.password = ""; url.hash = "";
      for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
      return url.toString();
    } catch { return "[invalid URL]"; }
  });
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[redacted]");
  text = text.replace(/(authorization|proxy-authorization|cookie|set-cookie|x-api-key):[^\r\n]*/gi, "$1: [redacted]");
  return text.replace(/(["']?(?:password|passwd|token|access_token|api[_-]?key|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "$1[redacted]");
}

/** Keep the acquisition reason independent of the transport-specific status and human-readable text. */
export function acquisitionFailure(error: unknown) {
  const reason = diagnosticMessage(error);
  if (error instanceof ToolboxError) {
    const codes: Partial<Record<ToolboxError["kind"], string>> = { permission_denied: "forbidden", authentication_failed: "unauthenticated",
      resource_not_found: "not_found" };
    const reasonCode = codes[error.kind] ?? error.kind;
    return { reason, reasonCode, sourceCode: error.code };
  }
  const reasonCode = error instanceof DoctorError && error.code ? error.code
    : error instanceof SyntaxError ? "invalid_response" : "operation_failed";
  return { reason, reasonCode };
}

export interface ExecutionDiagnostic {
  phase: string;
  target: string;
  command?: string;
  durationMs: number;
  kind: string;
  code?: string | number;
  message: string;
  causes: { message: string; code?: string | number }[];
}

/** @spec Persist a bounded, sanitized cause chain, never arbitrary error fields or protocol bodies. */
export function executionDiagnostic(error: unknown, context: { phase: string; target: string; startedAt: number; kind?: string }): ExecutionDiagnostic {
  const message = (value: unknown) => diagnosticMessage(value).slice(0, 2048);
  const code = (value: unknown): string | number | undefined => {
    const candidate = value && typeof value === "object" && "code" in value ? value.code : undefined;
    return typeof candidate === "string" ? message(candidate) : typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
  };
  const causes: ExecutionDiagnostic["causes"] = [];
  const seen = new Set<unknown>([error]);
  const pending: unknown[] = error instanceof AggregateError ? [...error.errors] : error instanceof Error && error.cause !== undefined ? [error.cause] : [];
  while (pending.length && causes.length < 6) {
    const cause = pending.shift();
    if (seen.has(cause)) continue;
    seen.add(cause);
    causes.push({ message: message(cause), code: code(cause) });
    if (cause instanceof AggregateError) pending.push(...cause.errors.slice(0, 6));
    else if (cause instanceof Error && cause.cause !== undefined) pending.push(cause.cause);
  }
  return { phase: context.phase, target: message(context.target),
    ...(error instanceof CommandError && error.command !== undefined && { command: message(error.command) }),
    durationMs: Math.max(0, Date.now() - context.startedAt),
    kind: error instanceof ToolboxError ? error.kind : context.kind ?? "operation_failed", code: code(error), message: message(error), causes };
}
