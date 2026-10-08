import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProducedHttpCase, WorkloadInstance } from "@compforge/doctor-plugin";
import type { SendHttp } from "../infra/http";
import { HTTP_DEFAULTS } from "../collect/shared/http/config";
import { captureHttpResponse } from "../collect/shared/http/capture";
import type { HttpAttemptObservation, HttpFinding, HttpRequestPlan } from "../collect/shared/http/model";
import { detectHttpAttempt } from "../collect/http/detector";
import { runProbes } from "../collect/probe-engine";
import { PROBE_RUNNABLE } from "../collect/protocol";

export interface CaseAttempt {
  caseId: string;
  description: string;
  entrypoint: string;
  target: WorkloadInstance;
  url: string;
  status: "passed" | "failed";
  observation: HttpAttemptObservation;
  findings: HttpFinding[];
}

/** Signed query strings and credentials never belong in a reusable diagnostic report. */
export function caseError(error: unknown, secrets: readonly string[] = []): string {
  let text = error instanceof Error ? error.message : String(error);
  text = text.replace(/https?:\/\/[^\s<>"']+/g, raw => {
    try {
      const url = new URL(raw);
      url.username = ""; url.password = ""; url.hash = "";
      for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
      return url.toString();
    } catch { return "[invalid URL]"; }
  });
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[redacted]");
  return text.replace(/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key):.*$/gim, "$1: [redacted]");
}

export async function executeHttpCase(input: {
  item: ProducedHttpCase; target: WorkloadInstance; directory: string; prefix: string;
  send: SendHttp; signal: AbortSignal;
}): Promise<CaseAttempt[]> {
  const { item, target, directory, prefix, signal } = input;
  const secrets = Object.entries(item.request.headers ?? {}).filter(([key]) => /authorization|cookie|token|key|secret/i.test(key)).map(([, value]) => value);
  for (const url of [item.request.url, ...(item.alternatives ?? []).map(entry => entry.url)]) {
    secrets.push(...new URL(url).searchParams.values());
  }
  const attempts: CaseAttempt[] = [];
  const entries = [{ id: "primary", url: item.request.url }, ...(item.alternatives ?? [])];
  for (const [index, entry] of entries.entries()) {
    signal.throwIfAborted();
    const path = `${prefix}/${index}`;
    const request: HttpRequestPlan = {
      requestId: prefix, entrypointId: entry.id, method: item.request.method ?? "GET", url: entry.url,
      headers: { ...item.request.headers }, followRedirects: false,
      timeoutMs: HTTP_DEFAULTS.timeoutSeconds * 1000,
      maxResponseBytes: HTTP_DEFAULTS.maxResponseMiB * 1024 * 1024, expect: item.expect,
    };
    // No DNS/TCP preflight: the real request must preserve the container's proxy and TLS behavior.
    // Redirects remain visible; forwarding credentials to an unknown redirect target is not implicit.
    const observations = await runProbes([{
      id: `http:${path}`, evaluate: () => PROBE_RUNNABLE,
      run: async (): Promise<HttpAttemptObservation[]> => {
        const captured = await captureHttpResponse(request, 1, join(directory, path), path,
          (request, localSignal) => input.send(request, AbortSignal.any([signal, localSignal])));
        return [{ id: `http-attempt:${path}`, kind: "http-attempt", schemaVersion: 1,
          producer: { origin: "core", id: "overview-http-case" }, requestId: prefix, entrypointId: entry.id,
          round: 1, directory: path, ...captured }];
      },
    }], undefined, {}, {});
    const observation = observations[0]!;
    const response = observation.response;
    if (response.error) response.error = caseError(response.error, secrets);
    const transport = response.transport;
    if (transport) {
      if (transport.error) transport.error = caseError(transport.error, secrets);
      if (transport.finalUrl) transport.finalUrl = caseError(transport.finalUrl);
      if (transport.redirectUrls) transport.redirectUrls = transport.redirectUrls.map(url => caseError(url));
    }
    const findings = detectHttpAttempt(request, observation);
    const attempt: CaseAttempt = { caseId: item.id, description: item.description, entrypoint: entry.id,
      target, url: caseError(entry.url), status: findings.length ? "failed" : "passed", observation, findings };
    // Raw text evidence is bounded by captureHttpResponse. Keep binary downloads and their original digest.
    for (const file of [observation.response.headersFile, observation.response.errorFile,
      ...(observation.response.contentType?.match(/text|json|xml/) ? [observation.response.bodyFile] : [])]) {
      if (file && existsSync(join(directory, file))) {
        writeFileSync(join(directory, file), caseError(readFileSync(join(directory, file), "utf8"), secrets), { mode: 0o600 });
      }
    }
    writeFileSync(join(directory, path, "attempt.json"), JSON.stringify(attempt, null, 2), { mode: 0o600 });
    attempts.push(attempt);
    // A working alternative never erases the original failure; all attempted routes remain evidence.
    if (attempt.status === "passed" || signal.aborted) break;
  }
  return attempts;
}
