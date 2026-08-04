import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Probe } from "../../protocol";
import type { SendHttp } from "../../../infra/http";
import { sleep } from "../../../infra/host/process";
import type { EvidenceBundle } from "../../evidence";
import { probeUnavailable, PROBE_RUNNABLE } from "../../protocol";
import { captureHttpResponse } from "../../shared/http/capture";
import { endpointKeyForUrl } from "../fact/inspect";
import type {
  HttpAttemptObservation,
  HttpInspectionFacts,
  HttpRequestPlan,
  SseResponseObservation,
} from "../../shared/http/model";

export interface HttpProbeConfig {
  intervalMs: number;
}

export interface HttpProbeContext {
  staging: string;
  bundle: EvidenceBundle;
  sendHttp: SendHttp;
  lastRound: number;
  log: (line: string) => void;
}

export function httpAttemptId(request: HttpRequestPlan, round: number): string {
  return `http:${request.requestId}:${request.entrypointId}:${round}`;
}

function serializeSse(sse: SseResponseObservation | undefined) {
  return sse ? {
    observation_id: sse.id,
    frame_count: sse.frameCount,
    json_event_count: sse.jsonEventCount,
    incomplete_frame: sse.incompleteFrame,
    frames: sse.frames,
    timeline: sse.timeline,
  } : undefined;
}

export function serializeHttpAttempt(observation: HttpAttemptObservation): Record<string, unknown> {
  const response = observation.response;
  return {
    observation_id: observation.id,
    request_id: observation.requestId,
    entrypoint_id: observation.entrypointId,
    round: observation.round,
    directory: observation.directory,
    response: {
      observation_id: response.id,
      started_at: response.startedAt,
      finished_at: response.finishedAt,
      duration_ms: response.durationMs,
      capture_complete: response.captureComplete,
      status_code: response.statusCode,
      content_type: response.contentType,
      body_bytes: response.bodyBytes,
      body_sha256: response.bodySha256,
      headers_file: response.headersFile,
      body_file: response.bodyFile,
      error_file: response.errorFile,
      termination_reason: response.terminationReason,
      error: response.error,
      transport: response.transport,
    },
    sse: serializeSse(observation.sse),
  };
}

async function enterRound(ctx: HttpProbeContext, round: number, intervalMs: number): Promise<void> {
  if (round <= ctx.lastRound) return;
  if (ctx.lastRound > 0 && intervalMs > 0) await sleep(intervalMs);
  ctx.lastRound = round;
}

export function makeHttpRequestProbe(
  request: HttpRequestPlan,
  round: number,
): Probe<HttpAttemptObservation, HttpInspectionFacts, HttpProbeConfig, HttpProbeContext> {
  const id = httpAttemptId(request, round);
  return {
    id,
    evaluate: (facts) => {
      if (facts.endpoints.status !== "collected") {
        return probeUnavailable(facts.endpoints.reason);
      }
      const endpoint = facts.endpoints.items.find(
        (item) => item.endpoint.key === endpointKeyForUrl(request.url),
      );
      if (!endpoint) return probeUnavailable(`Inspect 未返回 URL endpoint：${request.url}`);
      if (endpoint.status === "unreachable") {
        return probeUnavailable(
          `${endpoint.endpoint.authority} ${endpoint.phase ?? "connectivity"} 不可达：${endpoint.reason ?? "unknown"}`,
        );
      }
      return PROBE_RUNNABLE;
    },
    onUnavailable: (ctx, reason) => {
      ctx.bundle.fill(id, { status: "unavailable", reason });
    },
    run: async (ctx, _facts, config) => {
      await enterRound(ctx, round, config.intervalMs);
      const relativeDir = join(
        "attempts",
        `round-${String(round).padStart(3, "0")}`,
        request.requestId,
        request.entrypointId,
      );
      ctx.log(`[http] 第 ${round} 轮：${request.requestId}/${request.entrypointId}`);
      const capture = await captureHttpResponse(
        request,
        round,
        join(ctx.staging, relativeDir),
        relativeDir,
        ctx.sendHttp,
      );
      const observation: HttpAttemptObservation = {
        id: `http-attempt:${request.requestId}:${request.entrypointId}:${round}`,
        kind: "http-attempt",
        requestId: request.requestId,
        entrypointId: request.entrypointId,
        round,
        directory: relativeDir,
        response: capture.response,
        sse: capture.sse,
      };
      mkdirSync(join(ctx.staging, relativeDir), { recursive: true });
      writeFileSync(
        join(ctx.staging, relativeDir, "meta.json"),
        `${JSON.stringify(serializeHttpAttempt(observation), null, 2)}\n`,
        { mode: 0o600 },
      );
      ctx.bundle.fill(id, {
        status: capture.response.captureComplete ? "ok" : "failed",
        reason: capture.response.captureComplete
          ? undefined
          : capture.response.error ?? capture.response.terminationReason,
        durationMs: capture.response.durationMs,
      });
      return [observation];
    },
  };
}
