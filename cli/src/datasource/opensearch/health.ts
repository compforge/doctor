import { isOpenSearchReadApi } from "../../infra/search/opensearch";
import type { DataSourceHealthInput, DataSourceHealthResult, DataSourceHealthProbeResult } from "../health/extension";
import { CLUSTER_HEALTH_PROBE, CLUSTER_STATS_PROBE, SHARD_STATE_PROBE } from "./cluster";
import { CLUSTER_SETTINGS_PROBE, INDEX_WRITE_BLOCKS_PROBE, NODE_ALLOCATION_PROBE } from "./capacity";
import { detectVdbFindings, vdbCapacityConclusion } from "./detector";
import { groupVdbObservations } from "./model";

import type { OpenSearchHealthProbe } from "./probe";

const PROBES: readonly OpenSearchHealthProbe[] = [CLUSTER_HEALTH_PROBE, NODE_ALLOCATION_PROBE, CLUSTER_SETTINGS_PROBE,
  INDEX_WRITE_BLOCKS_PROBE, SHARD_STATE_PROBE, CLUSTER_STATS_PROBE];

/** Bounded waiting does not cancel the borrowed client; its command owner closes outstanding transport work. */
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}

export async function probeOpenSearchHealth({ search, signal, timeoutMs = 10_000 }: DataSourceHealthInput): Promise<DataSourceHealthResult> {
  const startedAt = new Date().toISOString();
  const deadline = AbortSignal.timeout(timeoutMs);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const probes: DataSourceHealthProbeResult[] = [];
  for (const spec of PROBES) {
    if (!isOpenSearchReadApi(search) || cancellation.aborted) {
      probes.push({ id: spec.id, status: "unavailable", reason: cancellation.aborted
        ? "健康探测已取消或超过时间预算" : "SearchEngine 不支持只读 cluster API" });
      continue;
    }
    try {
      const response = await bounded(search.request(spec.path, spec.query), cancellation);
      const raw = spec.project ? spec.project(response) : response;
      if (spec.id === "cluster-health" && !["green", "yellow", "red"].includes(String((raw as { status?: unknown })?.status))) {
        throw new Error("cluster health 响应缺少有效 status");
      }
      if (["node-allocation", "shard-state"].includes(spec.id) && !Array.isArray(raw)) {
        throw new Error(`${spec.id} 响应不是列表`);
      }
      const observation = spec.parse(raw);
      const incomplete = observation.kind === "opensearch-disk-settings"
        && [observation.low, observation.high, observation.floodStage].some(watermark => watermark.kind === "unknown");
      probes.push({ id: spec.id, status: incomplete ? "failed" : "ok", raw, observation,
        ...(incomplete ? { reason: "实时水位配置不完整，缺失项按常见默认值判断" } : {}) });
    } catch (error) {
      probes.push({ id: spec.id, status: "failed", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const observations = probes.flatMap(probe => probe.observation ? [probe.observation] : []);
  const grouped = groupVdbObservations(observations);
  const findings = detectVdbFindings(grouped);
  const status = probes.every(probe => probe.status === "ok") ? "ok" : observations.length ? "partial" : "unavailable";
  return { backend: "opensearch", startedAt, finishedAt: new Date().toISOString(), status,
    probes, observations, findings,
    summary: [`集群状态：${grouped.health?.status ?? "未知"}`, vdbCapacityConclusion(grouped),
      ...findings.map(finding => finding.summary),
      ...(status === "ok" ? [] : ["健康证据不完整，缺失项不能解释为正常"])].join("；") };
}
