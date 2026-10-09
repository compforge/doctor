import { diagnoseHttpFailure, type HttpFailureDiagnosis } from "../collect/shared/http/diagnosis";
import { caseHash } from "@compforge/spec-case/model";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { caseSseExpectation, type CaseProduceResult, type WorkloadInstance } from "@compforge/doctor-plugin";
import { inspectCaseSse, type CaseSseResult } from "./case-sse";
import type { SendHttp } from "../infra/http";
import { HTTP_DEFAULTS } from "../collect/shared/http/config";
import { captureHttpResponse } from "../collect/shared/http/capture";
import type { HttpAttemptObservation, HttpFinding, HttpRequestPlan } from "../collect/shared/http/model";
import { detectHttpAttempt } from "../collect/http/detector";
import { runProbes } from "../collect/probe-engine";
import { PROBE_RUNNABLE } from "../collect/protocol";

export interface CaseAttempt {
  caseId: string;
  caseHash: string;
  description: string;
  entrypoint: string;
  target: WorkloadInstance;
  url: string;
  status: "passed" | "failed";
  observation: HttpAttemptObservation;
  findings: HttpFinding[];
  sseCheck?: CaseSseResult;
  failure?: HttpFailureDiagnosis;
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

function bodySecrets(body: string | undefined): string[] {
  if (!body) return [];
  let value: unknown;
  try { value = JSON.parse(body); } catch { return []; }
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string" && /password|authorization|cookie|token|api.?key|secret/i.test(key)) values.push(entry);
      else visit(entry);
    }
  };
  visit(value);
  return values;
}

export async function checkHttpCase(input: {
  item: CaseProduceResult["cases"][number]; target: WorkloadInstance; directory: string; prefix: string;
  send: SendHttp; signal: AbortSignal;
}): Promise<CaseAttempt[]> {
  const { item, target, directory, prefix, signal } = input;
  const secrets = item.targets.flatMap(entry => [
    ...Object.entries(entry.headers ?? {}).filter(([key]) => /authorization|cookie|token|key|secret/i.test(key)).map(([, value]) => value),
    ...new URL(entry.url).searchParams.values(),
    ...bodySecrets(entry.body ?? item.case.input.body),
  ]);
  const attempts: CaseAttempt[] = [];
  for (const [index, entry] of item.targets.entries()) {
    signal.throwIfAborted();
    const path = `${prefix}/${index}`;
    const headers = Object.fromEntries(Object.entries(item.case.input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    // Runtime headers belong to this route; credentials must not leak into another route's request.
    for (const [key, value] of Object.entries(entry.headers ?? {})) headers[key.toLowerCase()] = value;
    const request: HttpRequestPlan = {
      requestId: prefix, entrypointId: entry.id, method: item.case.input.method,
      // An absent path preserves the exact signed URL returned by the producer.
      url: item.case.input.path === undefined ? entry.url : new URL(item.case.input.path, entry.url).toString(),
      body: (entry.body ?? item.case.input.body) === undefined ? undefined : new TextEncoder().encode(entry.body ?? item.case.input.body!),
      headers, followRedirects: false, expect: item.case.judge!.e2e!.http!,
      timeoutMs: HTTP_DEFAULTS.timeoutSeconds * 1000,
      maxResponseBytes: HTTP_DEFAULTS.maxResponseMiB * 1024 * 1024,
    };
    // Reuse Collect capture and diagnosis from the selected container; no Host fallback or preflight.
    const observations = await runProbes([{
      id: `http:${path}`, evaluate: () => PROBE_RUNNABLE,
      run: async (): Promise<HttpAttemptObservation[]> => {
        const captured = await captureHttpResponse(request, 1, join(directory, path), path,
          (request, localSignal) => input.send(request, AbortSignal.any([signal, localSignal])));
        return [{ id: `http-attempt:${path}`, kind: "http-attempt", schemaVersion: 1,
          producer: { origin: "core", id: "health-http-case" }, requestId: prefix, entrypointId: entry.id,
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
    const bodyText = response.contentType?.match(/text|json|xml/)
      ? readFileSync(join(directory, response.bodyFile), "utf8") : "";
    const failure = diagnoseHttpFailure(request, observation, bodyText.slice(0, 4096));
    const sseExpectation = caseSseExpectation(item.case);
    const sseCheck = sseExpectation ? inspectCaseSse(
      caseError(bodyText, secrets), sseExpectation, secrets,
    ) : undefined;
    const attempt: CaseAttempt = { caseId: item.case.id, caseHash: caseHash(item.case), description: item.case.desc ?? item.case.id, entrypoint: entry.id,
      target, url: caseError(request.url), status: failure || findings.length || sseCheck?.errors.length ? "failed" : "passed", observation, findings, sseCheck, failure };
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
