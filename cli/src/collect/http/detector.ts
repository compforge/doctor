import type { DiagnosisCoverage } from "../protocol";
import type {
  HttpAttemptObservation,
  HttpCoverageGoal,
  HttpDiagnosis,
  HttpEvidence,
  HttpExecution,
  HttpExecutionDiagnosis,
  HttpFinding,
  HttpInspectionFacts,
  HttpRequestGroup,
  HttpRequestPlan,
  HttpRequestSummary,
} from "../shared/http/model";

const HTTP_ATTEMPT_FINDING_META = {
  schemaVersion: 1,
  producer: { origin: "core" as const, id: "http-attempt-detector" },
};
const HTTP_RESPONSE_FINDING_META = {
  schemaVersion: 1,
  producer: { origin: "core" as const, id: "http-response-detector" },
};
const HTTP_ENDPOINT_FINDING_META = {
  schemaVersion: 1,
  producer: { origin: "core" as const, id: "http-endpoint-detector" },
};

function attemptFindingBase(observation: HttpAttemptObservation, kind: string) {
  const response = observation.response;
  return {
    ...HTTP_ATTEMPT_FINDING_META,
    id: `${kind}:${response.requestId}:${response.entrypointId}:${response.round}`,
    requestId: response.requestId,
    entrypointId: response.entrypointId,
    round: response.round,
    confidence: "high" as const,
    window: { startedAt: response.startedAt, endedAt: response.finishedAt },
  };
}

export function detectHttpAttempt(
  request: HttpRequestPlan,
  observation: HttpAttemptObservation,
): HttpFinding[] {
  const { response, sse } = observation;
  const findings: HttpFinding[] = [];
  if (!response.captureComplete) {
    findings.push({
      ...attemptFindingBase(observation, "http.transport-failed"),
      kind: "http.transport-failed",
      severity: "critical",
      evidence: [{ observationId: observation.id, role: "supporting" }],
      terminationReason: response.terminationReason,
      error: response.error,
    });
  }
  if (response.statusCode === undefined || !request.expect.status.includes(response.statusCode)) {
    findings.push({
      ...attemptFindingBase(observation, "http.unexpected-status"),
      kind: "http.unexpected-status",
      severity: "critical",
      evidence: [{ observationId: observation.id, role: "supporting" }],
      actual: response.statusCode,
      expected: request.expect.status,
    });
  }
  if (request.expect.contentType && !matchesContentType(response.contentType, request.expect.contentType)) {
    findings.push({
      ...attemptFindingBase(observation, "http.unexpected-content-type"),
      kind: "http.unexpected-content-type",
      severity: "warning",
      evidence: [{ observationId: observation.id, role: "supporting" }],
      actual: response.contentType,
      expected: request.expect.contentType,
    });
  }
  if (request.expect.maxDurationMs !== undefined && response.durationMs > request.expect.maxDurationMs) {
    findings.push({
      ...attemptFindingBase(observation, "http.response-too-slow"),
      kind: "http.response-too-slow",
      severity: "warning",
      evidence: [{ observationId: observation.id, role: "supporting" }],
      actualMs: response.durationMs,
      expectedMaxMs: request.expect.maxDurationMs,
    });
  }
  if (request.expect.sseTerminalEvent && !sse?.frames.some((frame) => frame.event === request.expect.sseTerminalEvent)) {
    findings.push({
      ...attemptFindingBase(observation, "http.sse-missing-terminal-event"),
      kind: "http.sse-missing-terminal-event",
      severity: "warning",
      evidence: [{ observationId: observation.id, role: "supporting" }],
      expectedEvent: request.expect.sseTerminalEvent,
      lastEvent: sse?.frames.at(-1)?.event,
    });
  }
  sse?.frames.forEach((frame, index) => {
    if (frame.event !== "error") return;
    findings.push({
      ...attemptFindingBase(observation, `http.sse-error-event:${index}`),
      kind: "http.sse-error-event",
      severity: "critical",
      evidence: [{ observationId: observation.id, role: "supporting" }],
      code: frame.code,
      traceId: frame.traceId,
      messageId: frame.messageId,
    });
  });
  if (sse?.incompleteFrame) {
    findings.push({
      ...attemptFindingBase(observation, "http.sse-incomplete-frame"),
      kind: "http.sse-incomplete-frame",
      severity: "warning",
      evidence: [{ observationId: observation.id, role: "supporting" }],
    });
  }
  return findings;
}

function matchesContentType(actual: string | undefined, expected: string): boolean {
  const actualMime = actual?.split(";", 1)[0]?.trim().toLowerCase();
  return actualMime === expected.trim().toLowerCase();
}

function percentile(values: readonly number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]!;
}

function summarizeRequest(requestId: string, executions: readonly HttpExecution[]): HttpRequestSummary {
  const successful = executions.filter((execution) => execution.requestSuccess).length;
  const durations = executions.map((execution) => execution.response.durationMs);
  const statusCounts: Record<string, number> = {};
  for (const execution of executions) {
    const status = String(execution.response.statusCode ?? "no-response");
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  return {
    requestId,
    entrypointId: executions[0]?.entrypointId ?? "unknown",
    total: executions.length,
    successful,
    failed: executions.length - successful,
    successRate: executions.length ? successful / executions.length : 0,
    durationMinMs: durations.length ? Math.min(...durations) : 0,
    durationP50Ms: percentile(durations, 0.5),
    durationP95Ms: percentile(durations, 0.95),
    durationMaxMs: durations.length ? Math.max(...durations) : 0,
    statusCounts,
  };
}

function normalizedContentType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

function entrypointDifferences(
  group: HttpRequestGroup,
  outer: HttpExecution,
  inner: HttpExecution,
): string[] {
  const differences: string[] = [];
  if (outer.response.captureComplete !== inner.response.captureComplete) differences.push("capture_complete");
  if (outer.response.statusCode !== inner.response.statusCode) differences.push("status_code");
  if (normalizedContentType(outer.response.contentType) !== normalizedContentType(inner.response.contentType)) {
    differences.push("content_type");
  }
  if (outer.response.terminationReason !== inner.response.terminationReason) differences.push("termination_reason");
  if (outer.requestSuccess !== inner.requestSuccess) differences.push("request_success");
  if (group.compare.body === "exact" && outer.response.bodySha256 !== inner.response.bodySha256) {
    differences.push("body");
  }
  if (group.compare.sseEvents && (outer.sse || inner.sse)) {
    const outerEvents = outer.sse?.frames.map((frame) => frame.event ?? "(missing)") ?? [];
    const innerEvents = inner.sse?.frames.map((frame) => frame.event ?? "(missing)") ?? [];
    if (JSON.stringify(outerEvents) !== JSON.stringify(innerEvents)) differences.push("sse_events");
  }
  return differences;
}

function detectEntrypointMismatches(
  groups: readonly HttpRequestGroup[],
  executions: readonly HttpExecution[],
): HttpFinding[] {
  const findings: HttpFinding[] = [];
  for (const group of groups) {
    if (group.entrypoints.length < 2) continue;
    const rounds = new Set(executions.filter((execution) => execution.requestId === group.id).map((execution) => execution.round));
    for (const round of rounds) {
      const attempts = group.entrypoints.map((entrypoint) => executions.find((execution) =>
        execution.requestId === group.id
        && execution.entrypointId === entrypoint.entrypointId
        && execution.round === round
      ));
      for (let index = 0; index < attempts.length - 1; index += 1) {
        const outer = attempts[index];
        const inner = attempts[index + 1];
        if (!outer || !inner) continue;
        const differences = entrypointDifferences(group, outer, inner);
        if (!differences.length) continue;
        findings.push({
          ...HTTP_RESPONSE_FINDING_META,
          id: `http.entrypoint-response-mismatch:${group.id}:${round}:${outer.entrypointId}:${inner.entrypointId}`,
          kind: "http.entrypoint-response-mismatch",
          severity: "warning",
          confidence: "high",
          evidence: [
            { observationId: outer.observationId, role: "supporting" },
            { observationId: inner.observationId, role: "contradicting" },
          ],
          requestId: group.id,
          round,
          outerEntrypoint: outer.entrypointId,
          innerEntrypoint: inner.entrypointId,
          differences,
        });
      }
    }
  }
  return findings;
}

export function diagnoseHttp(
  executions: readonly HttpExecution[],
  groups: readonly HttpRequestGroup[],
): HttpExecutionDiagnosis {
  const grouped = new Map<string, HttpExecution[]>();
  for (const execution of executions) {
    const key = `${execution.requestId}\u0000${execution.entrypointId}`;
    const group = grouped.get(key) ?? [];
    group.push(execution);
    grouped.set(key, group);
  }

  const aggregateFindings: HttpFinding[] = [];
  const summaries = [...grouped.values()].map((attempts) => {
    const requestId = attempts[0]!.requestId;
    const entrypointId = attempts[0]!.entrypointId;
    const summary = summarizeRequest(requestId, attempts);
    if (summary.successful > 0 && summary.failed > 0) {
      aggregateFindings.push({
        ...HTTP_RESPONSE_FINDING_META,
        id: `http.intermittent-failure:${requestId}:${entrypointId}`,
        kind: "http.intermittent-failure",
        severity: "warning",
        confidence: "high",
        evidence: attempts.filter((attempt) => !attempt.requestSuccess).map((attempt) => ({
          observationId: attempt.observationId,
          role: "supporting" as const,
        })),
        requestId,
        entrypointId,
        successful: summary.successful,
        failed: summary.failed,
      });
    }
    return summary;
  });
  return {
    executions,
    findings: [
      ...executions.flatMap((execution) => execution.findings),
      ...aggregateFindings,
      ...detectEntrypointMismatches(groups, executions),
    ],
    summaries,
  };
}

function requestPlan(
  groups: readonly HttpRequestGroup[],
  observation: HttpAttemptObservation,
): HttpRequestPlan {
  const group = groups.find((candidate) => candidate.id === observation.requestId);
  const request = group?.entrypoints.find(
    (candidate) => candidate.entrypointId === observation.entrypointId,
  );
  if (!request) {
    throw new Error(
      `HTTP Observation 引用了未知 request：${observation.requestId}/${observation.entrypointId}`,
    );
  }
  return request;
}

export function materializeHttpExecutions(
  observations: readonly HttpAttemptObservation[],
  groups: readonly HttpRequestGroup[],
): HttpExecution[] {
  return observations.map((observation) => {
    const findings = detectHttpAttempt(
      requestPlan(groups, observation),
      observation,
    );
    return {
      observationId: observation.id,
      requestId: observation.requestId,
      entrypointId: observation.entrypointId,
      round: observation.round,
      directory: observation.directory,
      response: observation.response,
      sse: observation.sse,
      findings,
      requestSuccess: findings.length === 0,
    };
  });
}

export function buildHttpEvidence(
  requestGroups: readonly HttpRequestGroup[],
  repeat: number,
) {
  return (
    observations: readonly HttpAttemptObservation[],
    facts: HttpInspectionFacts,
  ): HttpEvidence => ({ observations, facts, requestGroups, repeat });
}

export function detectHttpEndpointConnectivity(evidence: HttpEvidence): HttpFinding[] {
  if (evidence.facts.endpoints.status !== "collected") return [];
  return evidence.facts.endpoints.items.flatMap((endpoint, index): HttpFinding[] => {
    if (endpoint.status === "reachable") return [];
    const affectedRequests = [...new Set(endpoint.references.map(
      (reference) => `${reference.requestId}/${reference.entrypointId}`,
    ))];
    const base = {
      ...HTTP_ENDPOINT_FINDING_META,
      id: `http.endpoint-${endpoint.status}:${endpoint.endpoint.key}`,
      severity: endpoint.status === "unreachable" ? "critical" as const : "warning" as const,
      confidence: "high" as const,
      evidence: [{ factPath: `endpoints.items.${index}`, role: "supporting" as const }],
      endpoint: endpoint.endpoint.authority,
      reason: endpoint.reason ?? "endpoint connectivity inspect failed",
      affectedRequests,
    };
    if (endpoint.status === "unreachable") {
      return [{ ...base, kind: "http.endpoint-unreachable", phase: endpoint.phase ?? "tcp" }];
    }
    return [{ ...base, kind: "http.endpoint-inspection-unavailable" }];
  });
}

export function detectHttpResponses(evidence: HttpEvidence): readonly HttpFinding[] {
  return diagnoseHttp(
    materializeHttpExecutions(evidence.observations, evidence.requestGroups),
    evidence.requestGroups,
  ).findings;
}

export const httpDetectors = [detectHttpEndpointConnectivity, detectHttpResponses] as const;

export function buildHttpCoverage(
  evidence: HttpEvidence,
): DiagnosisCoverage<HttpCoverageGoal>[] {
  const endpointItems = evidence.facts.endpoints.status === "collected"
    ? evidence.facts.endpoints.items
    : [];
  const endpointMissing = evidence.facts.endpoints.status === "collected"
    ? endpointItems.filter((item) => item.status === "unknown").map(
        (item) => `${item.endpoint.authority}: ${item.reason ?? "Inspect unavailable"}`,
      )
    : [evidence.facts.endpoints.reason];
  const expected = evidence.requestGroups.reduce(
    (count, group) => count + group.entrypoints.length,
    0,
  ) * evidence.repeat;
  const complete = evidence.observations.filter(
    (observation) => observation.response.captureComplete,
  ).length;
  const responseMissing = expected === complete
    ? []
    : [`HTTP response observations: ${complete}/${expected}`];
  return [
    {
      goal: "endpoint-connectivity" as HttpCoverageGoal,
      status: endpointMissing.length ? "partial" as const : "sufficient" as const,
      missingEvidence: endpointMissing,
    },
    {
      goal: "http-response" as HttpCoverageGoal,
      status: complete === expected
        ? "sufficient" as const
        : complete === 0
          ? "insufficient" as const
          : "partial" as const,
      missingEvidence: responseMissing,
    },
  ];
}

export function buildHttpDiagnosis(
  evidence: HttpEvidence,
  findings: readonly HttpFinding[],
  coverage: readonly DiagnosisCoverage<HttpCoverageGoal>[],
): HttpDiagnosis {
  const executions = materializeHttpExecutions(evidence.observations, evidence.requestGroups);
  const summarized = diagnoseHttp(executions, evidence.requestGroups);
  return {
    facts: evidence.facts,
    observations: evidence.observations,
    executions,
    findings,
    summaries: summarized.summaries,
    coverage,
  };
}
