import type {
  CoverageBuilder,
  Detector,
  Diagnosis,
  Evidence,
  EvidenceBuilder,
  FindingMeta,
  ObservationMeta,
  Probe,
} from "./protocol";
import { runProbes } from "./probe-engine";

export interface DiagnosisEngineInput<
  Observation extends ObservationMeta,
  Facts,
  DomainEvidence extends Evidence<Observation, Facts>,
  DomainFinding extends FindingMeta<string>,
  Goal extends string,
  Config,
  Ctx = void,
> {
  ctx: Ctx;
  facts: Facts;
  config: Config;
  probes: readonly Probe<Observation, Facts, Config, Ctx>[];
  log: (line: string) => void;
  buildEvidence: EvidenceBuilder<Observation, Facts, DomainEvidence>;
  detectors: readonly Detector<DomainEvidence, DomainFinding>[];
  buildCoverage: CoverageBuilder<DomainEvidence, Goal>;
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
  Goal extends string,
  Config,
  Ctx = void,
>({
  ctx,
  facts,
  config,
  probes,
  log,
  buildEvidence,
  detectors,
  buildCoverage,
}: DiagnosisEngineInput<
  Observation,
  Facts,
  DomainEvidence,
  DomainFinding,
  Goal,
  Config,
  Ctx
>): Promise<Diagnosis<DomainEvidence, DomainFinding, Goal>> {
  // ctx 到 probe 为止。后续阶段只能从可持久化、可引用的 facts / evidence 推导。
  const observations = await runProbes(probes, ctx, facts, config, log);
  const evidence = buildEvidence(observations, facts);
  const findings = detectors.flatMap((detector) => detector(evidence));
  const coverage = buildCoverage(evidence);
  return { evidence, findings, coverage };
}
