export type FindingSeverity = "info" | "warning" | "critical";
export type FindingConfidence = "low" | "medium" | "high";
export type EvidenceRole = "supporting" | "contradicting" | "context";
export type CoverageStatus = "sufficient" | "partial" | "insufficient";

/** Inspect 产出的单个 Fact 是否取得；不是目标能力或 Worksheet 的执行状态。 */
export type FactStatus = "collected" | "unavailable" | "failed";

/** Stable implementation identity for persisted Evidence; target identity belongs in the payload. */
export type EvidenceProducer =
  | { origin: "core"; id: string }
  | { origin: "plugin"; plugin: string; service: string; id: string };

/** Schema identity and implementation provenance shared by persisted Evidence-derived records. */
export interface EvidenceSchemaMeta<Kind extends string = string> {
  /** Payload schema identity; origin is expressed separately by producer. */
  kind: Kind;
  /** Positive integer version of the payload identified by kind. */
  schemaVersion: number;
  /** Structured provenance; consumers must not infer it by parsing kind. */
  producer: EvidenceProducer;
}

/**
 * 领域子 Fact 的共享形状。
 *
 * `collected` 表示业务字段可用；预期的现场缺失使用 `unavailable`，执行或解析失败使用
 * `failed`。后两者必须携带原因，Probe/Detector 不再靠缺字段猜测为什么没有事实。
 */
export type Fact<Value extends object> =
  | ({ status: "collected" } & Value)
  | { status: Exclude<FactStatus, "collected">; reason: string };

export interface ObservationMeta extends EvidenceSchemaMeta {
  /** Stable within one diagnosis and valid as an EvidenceRef observationId. */
  id: string;
}

/**
 * Finding 的依据来源。两种：
 *   observation —— 采到的证据，指 ObservationMeta.id
 *   fact        —— Inspect 取得的环境事实，指 manifest.json 里 inspection_facts 下的
 *                  路径（如 "pythonProcess.tracemallocStartup"）
 *
 * Facts 也要能被引用：detector 说"定位不到具体对象**因为目标进程没开 tracemalloc**"时，
 * 依据在 Facts 里而不在任何 observation 里——不给它引用方式，这类结论就只能凭空断言。
 */
export type EvidenceRef =
  | { observationId: string; role: EvidenceRole }
  | { factPath: string; role: EvidenceRole };

/** Finding 是 detector 产出的领域判断；人类文案由各领域 renderer 生成。 */
export interface FindingMeta<Kind extends string> extends EvidenceSchemaMeta<Kind> {
  id: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  window?: {
    startedAt: string;
    endedAt: string;
  };
  evidence: readonly EvidenceRef[];
}

export interface DiagnosisCoverage<Goal extends string> {
  goal: Goal;
  status: CoverageStatus;
  missingEvidence: readonly string[];
}

/**
 * probe 对目标的访问方式。决定调度顺序，**不是**数据依赖。
 *
 * - `read`（默认）：只读目标。
 * - `destroy`：会替换 / 重建目标（如诊断 runtime rollout 会换掉 Pod），
 *   必须等所有 read 跑完——它一跑，别人读的现场就没了。
 *
 * 为什么不用 `dependsOn: [其它所有 probe]` 表达："我会毁掉你正在读的东西"不是
 * "我要你的数据"。用依赖边表达的话，以后加 probe 忘了加进 py-spy 的 dependsOn，
 * 调度器就认为它俩独立 → 并发跑 → rollout 在采集中途把 Pod 换了，而且**静默**。
 * `targetAccess` 的默认值是 `read`，新 probe 不写就自动排在毁灭者前面——
 * 忘不了。默认值往安全方向倒，不变量要有东西强制。
 */
export type ProbeTargetAccess = "read" | "destroy";

export type ProbeStrategyStatus = "succeeded" | "failed" | "declined";
export type ProbeStrategyDecision = "continue" | "stop";

/**
 * 一条 ProbeStrategy 的执行结论。status 记录发生了什么，decision 表达下一步怎么走；
 * 两者分开是因为“失败”既可能升级下一条策略，也可能证明继续升级没有意义。
 */
export interface ProbeStrategyOutcome<Result> {
  status: ProbeStrategyStatus;
  decision: ProbeStrategyDecision;
  result: Result;
  reason?: string;
}

export interface ProbeStrategyAttempt<Result> extends ProbeStrategyOutcome<Result> {
  strategyId: string;
}

/**
 * Probe 为取得同一种 Observation 使用的一条取证路径。
 *
 * Strategy 按注册顺序形成内部升级链；后续 Strategy 可以读取此前尝试，但这不是 Probe
 * 之间的数据依赖。工具前置条件和 mode 先在领域内筛选，必要副作用由 Strategy 内部通过
 * Operation 单独授权。
 */
export interface ProbeStrategy<Result, Facts, Ctx = void> {
  id: string;
  run: (
    ctx: Ctx,
    facts: Facts,
    attempts: readonly ProbeStrategyAttempt<Result>[],
  ) => Promise<ProbeStrategyOutcome<Result>>;
}

/** Engine 注入给下游 probe 的一个直接上游执行结果。 */
export interface UpstreamProbeResult<Observation extends ObservationMeta> {
  probeId: string;
  status: "ok" | "failed" | "unavailable" | "unnecessary";
  reason?: string;
  observations: readonly Observation[];
}

/** Probe 基于既有 Facts / 上游结果对本轮执行条件的同步判断。 */
export type ProbeEvaluation =
  | { runnable: true }
  | { runnable: false; status: "unavailable" | "unnecessary"; reason: string };

export const PROBE_RUNNABLE: ProbeEvaluation = { runnable: true };

export function probeUnavailable(reason: string): ProbeEvaluation {
  return { runnable: false, status: "unavailable", reason };
}

/** 上游证据已经足够回答目标问题，无需继续增加探测成本。 */
export function probeUnnecessary(reason: string): ProbeEvaluation {
  return { runnable: false, status: "unnecessary", reason };
}

/**
 * 一个 probe 采集**某一个方面**，在同一轮受限外部访问中产生一条或多条 observation。
 * 一个领域可以有多个 probe；evaluate 负责前置不具备，run 仍可能因没有可解析证据而产出零条；
 * probe 可以是交互式的（中途请求授权），也可以读取显式依赖 probe 的执行结果。
 *
 * Observation 的字段完全由领域定义；共享层只约束它如何进入诊断流程。
 */
/**
 * probe 的四类入参分工不同，别混：
 *
 * - **`ctx` 是干活的家伙什**（executor / bundle / target / 审批缓存）。probe 拿它发命令、
 *   记账、请求授权。它有进程生命周期，不是可序列化的分析素材，既不落 Bundle，也永远不该被
 *   Finding 引用——`factPath: "ctx.executor"` 是荒谬的，这就是它跟 Facts 必须分开的判据。
 * - **`facts` 是可引用的数据**。probe 靠它决定跑不跑，detector 也读它，Finding 用
 *   `factPath` 引用它。
 * - **`config` 是本次命令的用户选择与采集预算**。它是可序列化、影响离线复现的分析输入，
 *   由领域脱敏后落 Bundle；engine 把同一份 config 交给 evaluate 和 run，具体 Probe 可以读取，
 *   也可以忽略。
 * - **`progress` 是直接依赖的执行结果**。来源由 `dependsOn` 显式声明；没有依赖
 *   就是空数组。它不包含其它已执行 probe，更不会把证据镜像进 ctx。
 *
 * `Ctx` 不受约束、协议层原样透传——**没有空基类**。TS 是结构类型：`type BaseContext = {}`
 * 之后 `Ctx extends BaseContext` 连 `string` 都满足，约束不了任何东西。那是名义类型
 * 语言（Java / C#）的习惯，translate 不过来。等协议层真要拿 ctx 干事（比如 runProbes
 * 自动给每个 probe 记一笔账），再谈约束不迟。
 *
 * **detector 拿不到 ctx，这是硬边界。**detector 是 `evidence => Finding[]` 的纯函数；
 * 一旦它够得到 executor，早晚有人写出会发 I/O 的 detector，那 Finding 就不再能从证据包
 * 复现——"证据包能被现场人员、规则和不同模型重复分析"整条塌掉。
 */
export interface Probe<Observation extends ObservationMeta, Facts, Config, Ctx = void> {
  id: string;
  /** 直接数据依赖；缺省或空数组表示不依赖其它 probe。 */
  dependsOn?: readonly string[];
  /** 缺省 read。见 ProbeTargetAccess——不写就是安全的。 */
  targetAccess?: ProbeTargetAccess;
  /**
   * 基于本次 Config、已经取得的 Facts 与直接上游结果判断本轮能否执行。
   *
   * 必须同步且无 I/O；需要远端尝试才能知道的失败、Operation 授权与 Strategy 升级
   * 仍属于 run。必填是为了让新增 Probe 无法漏掉前置条件声明。
   */
  evaluate: (
    facts: Facts,
    config: Config,
    progress: readonly UpstreamProbeResult<Observation>[],
  ) => ProbeEvaluation;
  /** 必要但不可用时的领域记账；生命周期日志由 probe-engine 统一输出。 */
  onUnavailable?: (ctx: Ctx, reason: string) => void;
  /** 上游证据证明无需执行时的领域记账；与能力不足严格区分。 */
  onUnnecessary?: (ctx: Ctx, reason: string) => void;
  /**
   * 现场访问失败时的领域记账。只有声明该回调，runner 才把异常视为证据缺口并继续；
   * 未声明的异常仍向上抛，避免把 Doctor 编程错误伪装成 partial。
   */
  onFailed?: (ctx: Ctx, reason: string) => void;
  run: (
    ctx: Ctx,
    facts: Facts,
    config: Config,
    progress: readonly UpstreamProbeResult<Observation>[],
  ) => Promise<readonly Observation[]>;
}

/**
 * detector 能看到的全部东西：采到的 observations + Inspect 取得的 facts。
 *
 * facts 在这里，是因为 detector 经常要回答"**为什么**这份证据没拿到"——而原因
 * （tracemalloc 没启动 / handler 没注册 / 工具装不上）只存在于 Facts 里，任何
 * observation 都没有。缺了它，coverage 只能说"缺 tracemalloc 增量"，说不出
 * "你的进程没开 tracemalloc，加 PYTHONTRACEMALLOC=1 重启就能拿到"——后者才是
 * 现场人员要的。
 *
 * 边界仍在：detector 看到的 facts 由领域的 buildEvidence **显式挑选**，不是
 * 随手够到全局；且 Finding 引用 fact 要走 EvidenceRef.factPath，跟引用
 * observation 一样留痕。
 */
export interface Evidence<Observation extends ObservationMeta, Facts = unknown> {
  observations: readonly Observation[];
  facts: Facts;
}

export type EvidenceBuilder<
  Observation extends ObservationMeta,
  Facts,
  DomainEvidence extends Evidence<Observation, Facts>,
> = (
  observations: readonly Observation[],
  facts: Facts,
) => DomainEvidence;

export type Detector<
  DomainEvidence extends Evidence<ObservationMeta>,
  DomainFinding extends FindingMeta<string>,
> = (
  evidence: DomainEvidence,
) => readonly DomainFinding[];

export type CoverageBuilder<
  DomainEvidence extends Evidence<ObservationMeta>,
  Goal extends string,
> = (evidence: DomainEvidence) => readonly DiagnosisCoverage<Goal>[];

export interface Diagnosis<
  DomainEvidence extends Evidence<ObservationMeta>,
  DomainFinding extends FindingMeta<string>,
  Goal extends string,
> {
  evidence: DomainEvidence;
  findings: readonly DomainFinding[];
  coverage: readonly DiagnosisCoverage<Goal>[];
}
