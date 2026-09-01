import type {
  EvidenceProducer,
  ObservationMeta,
  Probe,
  UpstreamProbeResult,
} from "./protocol";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateProducer(producer: EvidenceProducer, label: string): void {
  if (!producer || typeof producer !== "object") {
    throw new Error(`${label}.producer must be a structured producer`);
  }
  if (producer.origin === "core") {
    if (!nonEmpty(producer.id)) throw new Error(`${label}.producer.id must be a non-empty string`);
    return;
  }
  if (producer.origin === "plugin") {
    if (!nonEmpty(producer.plugin) || !nonEmpty(producer.service) || !nonEmpty(producer.id)) {
      throw new Error(`${label}.producer plugin, service, and id must be non-empty strings`);
    }
    return;
  }
  throw new Error(`${label}.producer.origin must be core or plugin`);
}

function validateObservations(
  probeId: string,
  observations: readonly ObservationMeta[],
): void {
  for (const [index, observation] of observations.entries()) {
    const label = `probe ${probeId} observation[${index}]`;
    if (!nonEmpty(observation.id)) throw new Error(`${label}.id must be a non-empty string`);
    if (!nonEmpty(observation.kind)) throw new Error(`${label}.kind must be a non-empty string`);
    if (!Number.isInteger(observation.schemaVersion) || observation.schemaVersion < 1) {
      throw new Error(`${label}.schemaVersion must be a positive integer`);
    }
    validateProducer(observation.producer, label);
  }
}

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
  const results = new Map<string, UpstreamProbeResult<Observation>>();
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
      (probeId) => results.get(probeId)!,
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
      results.set(probe.id, {
        probeId: probe.id,
        status: evaluation.status,
        reason: evaluation.reason,
        observations: [],
      });
      pending.delete(probe.id);
      completed.add(probe.id);
      continue;
    }
    log(`[collect] 执行 Probe：${probe.id}…`);
    let probeObservations: readonly Observation[];
    try {
      probeObservations = await probe.run(ctx, facts, config, progress);
    } catch (error) {
      if (!probe.onFailed) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      probe.onFailed(ctx, reason);
      log(`[collect] Probe 失败：${probe.id}（${reason}）`);
      results.set(probe.id, { probeId: probe.id, status: "failed", reason, observations: [] });
      pending.delete(probe.id);
      completed.add(probe.id);
      continue;
    }
    // Metadata violations are Doctor/adapter contract bugs, not environmental Probe failures.
    validateObservations(probe.id, probeObservations);
    log(`[collect] Probe 完成：${probe.id}（${probeObservations.length} 条 Observation）`);
    results.set(probe.id, { probeId: probe.id, status: "ok", observations: probeObservations });
    observations.push(...probeObservations);
    pending.delete(probe.id);
    completed.add(probe.id);
  }

  return observations;
}
