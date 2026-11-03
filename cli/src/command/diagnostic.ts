import { ToolboxError } from "@compforge/harness-toolbox/errors";

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

export interface ExecutionDiagnostic {
  phase: string;
  target: string;
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
  return { phase: context.phase, target: message(context.target), durationMs: Math.max(0, Date.now() - context.startedAt),
    kind: error instanceof ToolboxError ? error.kind : context.kind ?? "operation_failed", code: code(error), message: message(error), causes };
}
