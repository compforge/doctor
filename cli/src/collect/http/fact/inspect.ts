import type { InspectHttpEndpoint } from "../../../infra/http";
import type { Inspect } from "../../inspection";
import type {
  HttpEndpointConnectivityFact,
  HttpEndpointTarget,
  HttpExecutionTarget,
  HttpInspectionFacts,
  HttpScenario,
} from "../../shared/http/model";

export interface HttpInspectContext {
  target: HttpExecutionTarget;
  inspectEndpoint: InspectHttpEndpoint;
}

function endpointForUrl(rawUrl: string): HttpEndpointTarget {
  const url = new URL(rawUrl);
  const scheme = url.protocol === "https:" ? "https" : "http";
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const port = url.port ? Number(url.port) : scheme === "https" ? 443 : 80;
  const authority = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  return { key: authority, scheme, host, port, authority };
}

export function resolveHttpScenarioEndpoints(scenario: HttpScenario) {
  const byKey = new Map<string, {
    endpoint: HttpEndpointTarget;
    references: { requestId: string; entrypointId: string; url: string }[];
  }>();
  for (const group of scenario.requests) {
    for (const request of group.entrypoints) {
      const endpoint = endpointForUrl(request.url);
      const existing = byKey.get(endpoint.key) ?? { endpoint, references: [] };
      existing.references.push({
        requestId: group.id,
        entrypointId: request.entrypointId,
        url: request.url,
      });
      byKey.set(endpoint.key, existing);
    }
  }
  return [...byKey.values()];
}

async function inspectAllEndpoints(
  scenario: HttpScenario,
  inspectEndpoint: InspectHttpEndpoint,
  timeoutMs: number,
): Promise<HttpEndpointConnectivityFact[]> {
  const pending = resolveHttpScenarioEndpoints(scenario);
  const facts: HttpEndpointConnectivityFact[] = [];
  const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (pending.length) {
      const plan = pending.shift();
      if (!plan) return;
      try {
        const inspected = await inspectEndpoint(plan.endpoint, timeoutMs);
        facts.push({
          endpoint: plan.endpoint,
          references: plan.references,
          status: inspected.reachable ? "reachable" : "unreachable",
          phase: inspected.phase,
          resolvedAddresses: inspected.resolvedAddresses,
          remoteAddress: inspected.remoteAddress,
          durationMs: inspected.durationMs,
          reason: inspected.reason,
        });
      } catch (error) {
        facts.push({
          endpoint: plan.endpoint,
          references: plan.references,
          status: "unknown",
          resolvedAddresses: [],
          durationMs: 0,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  await Promise.all(workers);
  return facts.sort((left, right) => left.endpoint.key.localeCompare(right.endpoint.key));
}

export function makeHttpEndpointInspect(
  scenario: HttpScenario,
  timeoutMs: number,
): Inspect<HttpInspectionFacts, HttpInspectContext> {
  return {
    id: "http-endpoint-connectivity",
    run: async (ctx) => ({
      execution: { status: "collected", target: ctx.target },
      endpoints: {
        status: "collected",
        items: await inspectAllEndpoints(scenario, ctx.inspectEndpoint, timeoutMs),
      },
    }),
  };
}

export function endpointKeyForUrl(url: string): string {
  return endpointForUrl(url).key;
}
