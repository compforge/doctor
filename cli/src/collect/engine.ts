import type { EvidenceGapFinding } from "./evidence-gaps";
import { currentCommandSignal } from "../command/execution-scope";
import type {
  Detector,
  Diagnosis,
  Evidence,
  EvidenceBuilder,
  FindingMeta,
  ObservationMeta,
  Probe,
} from "./protocol";
import type { Inspect } from "./inspection";
import { runDetectors } from "./detector-engine";
import { freezeFacts, runInspects } from "./inspect-engine";
import { ConcurrencyPool } from "@compforge/harness-toolbox/concurrency";
import { runProbes } from "./probe-engine";

export interface CollectEngineInput<
  Observation extends ObservationMeta,
  Facts extends object,
  DomainEvidence extends Evidence<Observation, Facts>,
  DomainFinding extends FindingMeta<string>,
  Config,
  Ctx = void,
> {
  ctx: Ctx;
  signal?: AbortSignal;
  config: Config;
  inspects: readonly Inspect<Facts, Ctx>[];
  /** Domain-owned projection of completed Inspect batches, including interrupted acquisition. */
  checkpointPartialFacts?: (facts: Readonly<Partial<Facts>>) => void | Promise<void>;
  /** Persist the complete frozen Facts snapshot before any Probe is planned or run. */
  checkpointFacts?: (facts: Readonly<Facts>) => void | Promise<void>;
  /** Probe planning starts only after every Inspect has completed and Facts are deeply frozen. */
  planProbes: (
    facts: Readonly<Facts>,
    config: Config,
    ctx: Ctx,
  ) => readonly Probe<Observation, Facts, Config, Ctx>[];
  log: (line: string) => void;
  buildEvidence: EvidenceBuilder<Observation, Facts, DomainEvidence>;
  detectors: readonly Detector<DomainEvidence, DomainFinding | EvidenceGapFinding>[];
}

export interface CollectEngineResult<
  Facts extends object,
  DomainEvidence extends Evidence<ObservationMeta, Facts>,
  DomainFinding extends FindingMeta<string>,
> {
  facts: Readonly<Facts>;
  diagnosis: Diagnosis<DomainEvidence, DomainFinding>;
}

export interface DiagnosisEngineInput<
  Observation extends ObservationMeta,
  Facts,
  DomainEvidence extends Evidence<Observation, Facts>,
  DomainFinding extends FindingMeta<string>,
  Config,
  Ctx = void,
> {
  ctx: Ctx;
  signal?: AbortSignal;
  facts: Facts;
  config: Config;
  probes: readonly Probe<Observation, Facts, Config, Ctx>[];
  log: (line: string) => void;
  buildEvidence: EvidenceBuilder<Observation, Facts, DomainEvidence>;
  detectors: readonly Detector<DomainEvidence, DomainFinding | EvidenceGapFinding>[];
}

/**
 * 通用诊断主链路中已经跨领域稳定的部分。
 *
 * Inspect 的失败语义和最终产物交付仍由领域编排：例如 Redis 把预期失败保留为带状态
 * 的子 Fact，再由 Probe.evaluate 决定是否执行；共享层不擅自制造 skip / render 钩子。
 */
export async function runDiagnosis<
  Observation extends ObservationMeta,
  Facts,
  DomainEvidence extends Evidence<Observation, Facts>,
  DomainFinding extends FindingMeta<string>,
  Config,
  Ctx = void,
>({
  ctx,
  signal = currentCommandSignal(),
  facts,
  config,
  probes,
  log,
  buildEvidence,
  detectors,
}: DiagnosisEngineInput<
  Observation,
  Facts,
  DomainEvidence,
  DomainFinding,
  Config,
  Ctx
>): Promise<Diagnosis<DomainEvidence, DomainFinding>> {
  // ctx 到 probe 为止。后续阶段只能从可持久化、可引用的 facts / evidence 推导。
  const observations = await runProbes(probes, ctx, facts, config, log, signal);
  const evidence = buildEvidence(observations, facts);
  const findings = signal?.aborted ? [] : runDetectors(detectors, evidence);
  return { evidence, findings };
}

/**
 * Core-owned Collect Execute pipeline.
 *
 * @spec runCollect completes and freezes all Inspect Facts before planning or running any Probe
 * @spec runCollect checkpoints frozen Facts before Probe planning and aborts if the checkpoint fails
 * @rule Core alone advances Inspect → Probe → Detector; contributions provide work but never drive phases
 * @see {@link ../../docs/kernel.md}
 */
export async function runCollect<
  Observation extends ObservationMeta,
  Facts extends object,
  DomainEvidence extends Evidence<Observation, Facts>,
  DomainFinding extends FindingMeta<string>,
  Config,
  Ctx = void,
>({
  ctx,
  signal = currentCommandSignal(),
  config,
  inspects,
  checkpointFacts,
  checkpointPartialFacts,
  planProbes,
  log,
  buildEvidence,
  detectors,
}: CollectEngineInput<
  Observation,
  Facts,
  DomainEvidence,
  DomainFinding,
  Config,
  Ctx
>): Promise<CollectEngineResult<Facts, DomainEvidence, DomainFinding>> {
  const facts = await runInspects(inspects, ctx, log, signal, checkpointPartialFacts);
  await checkpointFacts?.(facts);
  const diagnosis = await runDiagnosis({
    ctx,
    signal,
    facts: facts as Facts,
    config,
    probes: signal?.aborted ? [] : planProbes(facts, config, ctx),
    log,
    buildEvidence,
    detectors,
  });
  return { facts, diagnosis };
}

/**
 * One acquisition snapshot, followed by independently scheduled item diagnoses.
 *
 * @spec Batch Collect completes and freezes Inspect once before any item plans a Probe
 * @spec Singleton batches use the same projection and failure isolation as larger batches
 * @why Projection belongs after acquisition: replaying Inspect would invent a second producer of the same Facts
 */
export async function runCollectBatch<
  Observation extends ObservationMeta,
  Facts extends object,
  DomainEvidence extends Evidence<Observation, Facts>,
  DomainFinding extends FindingMeta<string>,
  Config,
  Ctx,
>(input: Omit<CollectEngineInput<Observation, Facts, DomainEvidence, DomainFinding, Config, Ctx>, "config"> & {
  items: readonly {
    ctx: Ctx;
    config: Config;
    projectFacts?: (facts: Readonly<Facts>) => Facts;
  }[];
  concurrency?: number;
}): Promise<{
  facts: Readonly<Facts>;
  items: PromiseSettledResult<CollectEngineResult<Facts, DomainEvidence, DomainFinding>>[];
}> {
  const pool = new ConcurrencyPool(input.concurrency ?? 1);
  const signal = input.signal ?? currentCommandSignal();
  signal?.throwIfAborted();
  const facts = await runInspects(input.inspects, input.ctx, input.log, signal, input.checkpointPartialFacts);
  await input.checkpointFacts?.(facts);
  const items = await Promise.allSettled(input.items.map(item => pool.run(async () => {
    const projected = item.projectFacts ? freezeFacts(item.projectFacts(facts)) : facts;
    const diagnosis = await runDiagnosis({
      ctx: item.ctx,
      signal,
      config: item.config,
      facts: projected as Facts,
      probes: input.planProbes(projected, item.config, item.ctx),
      log: input.log,
      buildEvidence: input.buildEvidence,
      detectors: input.detectors,
    });
    return { facts: projected, diagnosis };
  }, signal)));
  return { facts, items };
}
