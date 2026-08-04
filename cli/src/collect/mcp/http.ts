import type { Executor } from "../../infra/k8s/executor";
import type { KubernetesPodLogAccess } from "../../infra/k8s/pod-log";
import type { McpHttpRequestPlan } from "@compforge/doctor-plugin";
import type { HttpCapture } from "./model";

function statusFromRaw(raw: string): number | undefined {
  const matches = [...raw.matchAll(/^HTTP\/\S+\s+(\d{3})\b/gm)];
  const value = matches.at(-1)?.[1];
  return value ? Number(value) : undefined;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function readableBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** Render a deterministic, copy-pasteable POSIX shell command for the mapped HTTP request. */
export function renderHttpPlanAsCurl(plan: McpHttpRequestPlan): string {
  const method = /^[A-Z]+$/.test(plan.method) ? plan.method : quotePosix(plan.method);
  const clauses = [`curl --location --request ${method} ${quotePosix(plan.url)}`];
  for (const [key, value] of Object.entries(plan.headers)) {
    clauses.push(`--header ${quotePosix(`${key}: ${value}`)}`);
  }
  if (plan.body !== undefined) {
    if (!Object.keys(plan.headers).some((key) => key.toLowerCase() === "content-type")) {
      // --data-raw 会自行补 Content-Type；显式压掉，保持与 gateway request plan 一致。
      clauses.push(`--header ${quotePosix("Content-Type:")}`);
    }
    clauses.push(`--data-raw ${quotePosix(readableBody(plan.body))}`);
  }
  return `${clauses.join(" \\\n")}\n`;
}

export async function executeHttpFromGatewayPod(
  executor: Executor,
  pod: string,
  plan: McpHttpRequestPlan,
  timeoutMs: number,
): Promise<HttpCapture> {
  const command = [
    "curl",
    "--silent",
    "--show-error",
    "--include",
    "--location",
    "--compressed",
    "--max-time",
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    "--request",
    plan.method,
  ];
  for (const [key, value] of Object.entries(plan.headers)) command.push("--header", `${key}: ${value}`);
  if (plan.body !== undefined) {
    if (!Object.keys(plan.headers).some((key) => key.toLowerCase() === "content-type")) {
      // curl 加 --data-binary 会自行补 Content-Type；网关的 Go request 不会，显式压掉这个差异。
      command.push("--header", "Content-Type:");
    }
    command.push("--data-binary", "@-");
  }
  command.push(plan.url);
  const result = await executor.exec({ pod }, command, {
    stdin: plan.body,
    timeoutMs: timeoutMs + 5_000,
  });
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    rawResponse: result.stdout,
    stderr: result.stderr,
    statusCode: statusFromRaw(result.stdout),
    command: result.command,
  };
}

export async function collectGatewayLogs(
  access: KubernetesPodLogAccess,
  pods: readonly string[],
  sinceTime: string,
  traceId: string,
  toolName: string,
): Promise<{ output: string; command: string[]; ok: boolean; reason?: string; durationMs: number }> {
  const started = Date.now();
  const sections: string[] = [];
  const commands: string[][] = [];
  const errors: string[] = [];
  for (const pod of pods) {
    const result = await access.collectPodLogs({ pod, sinceTime });
    commands.push(result.command);
    if (!result.ok) {
      errors.push(`${pod}: ${result.stderr.trim().split("\n")[0] || `exit=${result.exitCode}`}`);
      continue;
    }
    const lines = result.stdout.split(/\r?\n/).filter((line) => {
      const lower = line.toLowerCase();
      return line.includes(traceId)
        || line.includes(toolName)
        || lower.includes("x509")
        || lower.includes("certificate")
        || lower.includes("failed to execute")
        || lower.includes("unknown authority");
    });
    sections.push(`--- pod: ${pod} ---\n${lines.length ? lines.join("\n") : "(window 内没有匹配 trace/tool/error 的日志)"}`);
  }
  return {
    output: `${sections.join("\n\n")}\n`,
    command: commands.length === 1 ? commands[0]! : ["kubectl", "logs", "<all-mcp-service-pods>", `--since-time=${sinceTime}`],
    ok: sections.length > 0,
    reason: errors.length ? errors.join("; ") : undefined,
    durationMs: Date.now() - started,
  };
}
