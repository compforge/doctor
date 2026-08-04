import type {
  ObservationMeta,
  Probe,
  UpstreamProbeResult,
} from "./protocol";

function validateProbes<Observation extends ObservationMeta, Facts, Config, Ctx>(
  probes: readonly Probe<Observation, Facts, Config, Ctx>[],
): void {
  const byId = new Map<string, Probe<Observation, Facts, Config, Ctx>>();
  for (const probe of probes) {
    if (byId.has(probe.id)) throw new Error(`duplicate probe id: ${probe.id}`);
    byId.set(probe.id, probe);
  }

  for (const probe of probes) {
    const seen = new Set<string>();
    for (const dependencyId of probe.dependsOn ?? []) {
      if (seen.has(dependencyId)) {
        throw new Error(`probe ${probe.id} declares duplicate dependency: ${dependencyId}`);
      }
      seen.add(dependencyId);
      const dependency = byId.get(dependencyId);
      if (!dependency) throw new Error(`probe ${probe.id} depends on unknown probe: ${dependencyId}`);
      if ((probe.targetAccess ?? "read") === "read" && dependency.targetAccess === "destroy") {
        throw new Error(`read probe ${probe.id} cannot depend on destroy probe: ${dependencyId}`);
      }
    }
  }
}

/**
 * 按显式数据依赖做确定性拓扑调度，并把直接上游结果注入当前 probe。
 *
 * `targetAccess` 是独立的安全约束：所有 read probe 都完成后才能执行 destroy probe。
 * 当前保持串行；同一批可运行 probe 按注册顺序执行，便于日志和证据稳定复现。
 */
export async function runProbes<Observation extends ObservationMeta, Facts, Config, Ctx = void>(
  probes: readonly Probe<Observation, Facts, Config, Ctx>[],
  ctx: Ctx,
  facts: Facts,
  config: Config,
  log: (line: string) => void = () => {},
): Promise<Observation[]> {
  validateProbes(probes);
  const readIds = probes
    .filter((probe) => (probe.targetAccess ?? "read") === "read")
    .map((probe) => probe.id);
  const pending = new Set(probes.map((probe) => probe.id));
  const completed = new Set<string>();
  const results = new Map<string, readonly Observation[]>();
  const observations: Observation[] = [];

  while (pending.size > 0) {
    const probe = probes.find((candidate) => {
      if (!pending.has(candidate.id)) return false;
      const dependencies = candidate.dependsOn ?? [];
      if (!dependencies.every((id) => completed.has(id))) return false;
      return candidate.targetAccess !== "destroy" || readIds.every((id) => completed.has(id));
    });
    if (!probe) {
      throw new Error(`probe dependency cycle: ${[...pending].join(", ")}`);
    }

    const progress: UpstreamProbeResult<Observation>[] = (probe.dependsOn ?? []).map(
      (probeId) => ({ probeId, observations: results.get(probeId)! }),
    );
    const evaluation = probe.evaluate(facts, config, progress);
    if (!evaluation.runnable) {
      if (evaluation.status === "unnecessary") {
        log(`[collect] Probe 无需执行：${probe.id}（${evaluation.reason}）`);
        probe.onUnnecessary?.(ctx, evaluation.reason);
      } else {
        log(`[collect] Probe 不可用：${probe.id}（${evaluation.reason}）`);
        probe.onUnavailable?.(ctx, evaluation.reason);
      }
      results.set(probe.id, []);
      pending.delete(probe.id);
      completed.add(probe.id);
      continue;
    }
    log(`[collect] 执行 Probe：${probe.id}…`);
    const probeObservations = await probe.run(ctx, facts, config, progress);
    log(`[collect] Probe 完成：${probe.id}（${probeObservations.length} 条 Observation）`);
    results.set(probe.id, probeObservations);
    observations.push(...probeObservations);
    pending.delete(probe.id);
    completed.add(probe.id);
  }

  return observations;
}
