import { sameWorkloadInstance } from "@compforge/harness-common";
import { evidenceGaps } from "../evidence-gaps";
import type { InspectEvidence, InspectFinding, PodClockObservation } from "./model";

export const CLOCK_THRESHOLD_MS = 5_000;
const HOST_CLOCK_TOLERANCE_MS = 100;

export interface PodClockEstimate {
  lowerMs: number;
  upperMs: number;
  offsetMs: number;
  uncertaintyMs: number;
  roundTripMs: number;
  sampledAtMs: number;
}

/** Reject a moving reference across the whole batch, including jumps between different Pod probes. */
export function unstableClockReferences(observations: readonly PodClockObservation[]): Set<string> {
  return new Set(observations.filter(observation => observation.samples.some(sample => {
    const reference = observation.reference;
    return Math.abs((sample.hostStartMs - reference.wallTimeMs) - (sample.monotonicStartMs - reference.monotonicMs)) > HOST_CLOCK_TOLERANCE_MS
      || Math.abs((sample.hostEndMs - reference.wallTimeMs) - (sample.monotonicEndMs - reference.monotonicMs)) > HOST_CLOCK_TOLERANCE_MS;
  })).map(observation => observation.reference.id));
}

/**
 * @spec Remote read occurred inside [hostStart, hostEnd]; no symmetric network delay assumption is needed.
 * @why Unix output is truncated, so the upper bound includes its resolution plus host rounding.
 * @see {@link cli/docs/commands/inspect.md}
 */
export function estimatePodClock(observation: PodClockObservation): { estimate?: PodClockEstimate; reason?: string } {
  const samples = observation.samples.filter(sample => sample.podTimeMs !== undefined && sample.resolutionMs !== undefined && !sample.reason);
  if (!samples.length) return { reason: observation.reason ?? "未取得有效时钟样本" };
  const intervals = samples.map(sample => ({
    lowerMs: sample.podTimeMs! - sample.hostEndMs - 1,
    upperMs: sample.podTimeMs! + sample.resolutionMs! - sample.hostStartMs + 1,
    roundTripMs: sample.monotonicEndMs - sample.monotonicStartMs,
    sampledAtMs: sample.hostStartMs,
  }));
  if (Math.max(...intervals.map(item => item.lowerMs)) > Math.min(...intervals.map(item => item.upperMs))) {
    return { reason: "多次采样的偏差区间不相交，采样期间时钟可能发生变化" };
  }
  const best = intervals.reduce((left, right) => left.upperMs - left.lowerMs <= right.upperMs - right.lowerMs ? left : right);
  return { estimate: { ...best, offsetMs: (best.lowerMs + best.upperMs) / 2, uncertaintyMs: (best.upperMs - best.lowerMs) / 2 } };
}

export function clockObservations(evidence: InspectEvidence): PodClockObservation[] {
  return evidence.observations.filter((item): item is PodClockObservation => item.kind === "pod-clock");
}

export function detectPodClocks(evidence: InspectEvidence): InspectFinding[] {
  const observations = clockObservations(evidence);
  const unstable = unstableClockReferences(observations);
  const findings: InspectFinding[] = [];
  const valid: Array<{ observation: PodClockObservation; estimate: PodClockEstimate }> = [];
  const missing: string[] = [];
  if (evidence.facts.serviceTargets.status !== "collected") missing.push(evidence.facts.serviceTargets.reason);
  else for (const service of Object.values(evidence.facts.serviceTargets.services)) for (const workload of Object.values(service.workloads)) {
    if (workload.podRuntime.status !== "collected") missing.push(`${service.service}/${workload.name}: ${workload.podRuntime.reason}`);
    else if (!workload.podRuntime.pods.length) missing.push(`${service.service}/${workload.name}: 未发现 Pod，无法比较时钟`);
    else for (const pod of workload.podRuntime.pods) {
      if (!observations.some(item => item.service === service.service && item.workload === workload.name && item.instance.uid === pod.instance.uid)) {
        missing.push(`${service.service}/${workload.name}/${pod.pod}: 未采样`);
      }
    }
  }
  for (const observation of observations) {
    const label = `${observation.service}/${observation.pod}`;
    const { estimate, reason } = estimatePodClock(observation);
    if (unstable.has(observation.reference.id)) {
      missing.push(`${label}: Doctor Host 壁钟与单调时钟不一致，本批次不能作为稳定参照`);
      continue;
    }
    if (!estimate) { missing.push(`${label}: ${reason}`); continue; }
    if (observation.reason) missing.push(`${label}: ${observation.reason}`);
    valid.push({ observation, estimate });
    const minimumOffsetMs = Math.max(estimate.lowerMs, -estimate.upperMs);
    if (minimumOffsetMs > CLOCK_THRESHOLD_MS) findings.push({
      id: `clock-host-offset:${observation.id}`, kind: "clock.host-offset", schemaVersion: 1,
      producer: { origin: "core", id: "pod-clock" }, severity: "warning", confidence: "high",
      subject: label, thresholdMs: CLOCK_THRESHOLD_MS, minimumOffsetMs,
      message: `${label} 相对 Doctor Host (${observation.reference.host}) 的时钟偏差至少 ${(minimumOffsetMs / 1000).toFixed(2)}s；尚不能确定哪一侧时间正确`,
      evidence: [{ observationId: observation.id, role: "supporting" }],
    });
    else if (estimate.lowerMs < -CLOCK_THRESHOLD_MS || estimate.upperMs > CLOCK_THRESHOLD_MS) {
      missing.push(`${label}: 采样误差区间跨越 5s 阈值，无法判断与 Host 的偏差是否超限`);
    }
  }
  // Compare extrema within a common reference. This remains linear in Pod count and keeps both witnesses.
  const groups = new Map<string, typeof valid>();
  for (const value of valid) {
    const key = value.observation.reference.id;
    const group = groups.get(key) ?? [];
    group.push(value); groups.set(key, group);
  }
  for (const [reference, group] of groups) {
    if (group.length < 2) continue;
    const ahead = group.reduce((a, b) => a.estimate.lowerMs > b.estimate.lowerMs ? a : b);
    const behind = group.reduce((a, b) => a.estimate.upperMs < b.estimate.upperMs ? a : b);
    // Each local offset can move by the allowed reference tolerance between Pod reads.
    const minimumOffsetMs = ahead.estimate.lowerMs - behind.estimate.upperMs - 2 * HOST_CLOCK_TOLERANCE_MS;
    if (minimumOffsetMs > CLOCK_THRESHOLD_MS && sameWorkloadInstance(ahead.observation.instance, behind.observation.instance)) {
      missing.push(`${ahead.observation.pod}: 同一个 Pod 的重复观察存在时间差异，不能作为跨 Pod 时钟差异的证据`);
      continue;
    }
    if (minimumOffsetMs > CLOCK_THRESHOLD_MS) findings.push({
      id: `clock-pod-spread:${reference}`, kind: "clock.pod-spread", schemaVersion: 1,
      producer: { origin: "core", id: "pod-clock" }, severity: "warning", confidence: "high", subject: "pod-clock",
      thresholdMs: CLOCK_THRESHOLD_MS, minimumOffsetMs,
      message: `${ahead.observation.pod} (Node ${ahead.observation.nodeName ?? "unknown"}) 比 ${behind.observation.pod} (Node ${behind.observation.nodeName ?? "unknown"}) 快至少 ${(minimumOffsetMs / 1000).toFixed(2)}s；表示本次采样窗口内的 Pod 时钟差异`,
      evidence: [ahead, behind].map(item => ({ observationId: item.observation.id, role: "supporting" })),
    });
  }
  findings.push(...evidenceGaps("pod-clock", missing, evidence, [
    { factPath: "serviceTargets", role: "context" },
    ...observations.map(item => ({ observationId: item.id, role: "supporting" as const })),
  ]));
  return findings;
}
