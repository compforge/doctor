import type { Case } from "@compforge/spec-case/model";
import type { PluginContext } from "./context";
import type { RegisteredExtension } from "./extension";
import type { ServiceDataSource } from "./datasource";
import type {
  Fact,
  Identity,
  InspectQueryResult,
  Query,
} from "./capability";
import type { JsonObject } from "./json";
import type { ProbeRunner } from "./probe";
import type { Environment, Service, WorkloadInstance } from "@compforge/harness-common";

export interface ServiceEndpoint {
  /** Explicit network host; a logical Service name is never treated as transport identity. */
  host: string;
  port: number;
}

export interface TenantSummary {
  id: string;
  name: string;
  displayName: string;
}

export interface UserSummary {
  id: string;
  name: string;
  displayName: string;
}

export interface UserDirectorySearch {
  tenantId: string;
  query?: string;
  page: number;
  pageSize: number;
}

export interface UserDirectorySearchResult {
  users: UserSummary[];
  total: number;
}

export interface TenantDirectory {
  listActive(): Promise<TenantSummary[]>;
  getByName(name: string): Promise<TenantSummary>;
  /** Optional because tenant-only directory providers do not need to expose users. */
  searchActiveUsers?(input: UserDirectorySearch): Promise<UserDirectorySearchResult>;
}

export interface ServiceMetricQuery {
  /** Query for a cumulative /metrics snapshot. */
  instant: string;
  /** Query for a watched window. `{{window}}` is replaced with the collection duration. */
  range: string;
}

export interface ServiceMetricChart {
  id: string;
  title: string;
  description: string;
  kind: "line" | "pie";
  query: ServiceMetricQuery;
  unit?: "seconds" | "percent" | "count";
  /** PromQL result labels used as the chart series/slice name. */
  label?: string;
}

export interface ServiceMetricDetector {
  id: string;
  title: string;
  query: ServiceMetricQuery;
  operator: "gt";
  threshold: number;
  severity: "warning" | "critical";
  message: string;
}

/** Common identity carried by every Plugin-side Probe contribution. */
export interface ServiceProbe {
  id: string;
  kind: string;
  schemaVersion: number;
}

export interface KubernetesAppArmorUnconfinedInspectionProbe extends ServiceProbe {
  kind: "kubernetes.apparmor-unconfined-admission";
  schemaVersion: 1;
  /** Resolve the caller identity and probe image from this Service's running workload. */
  subject: "workload-service-account";
}

/** Service-owned declarations adapted to common probes by Doctor. */
export type ServiceEnvironmentProbe = KubernetesAppArmorUnconfinedInspectionProbe;

/** Service-owned Prometheus contract consumed by doctor metric. */
export interface MetricConfiguration {
  endpoint: ServiceEndpoint & { path: string };
  /** Limits embedded scraping to the metric families required by this declaration. */
  metricNames: readonly string[];
  charts: readonly ServiceMetricChart[];
  detectors?: readonly ServiceMetricDetector[];
}

/** Protocol facts returned by one Case trigger; Doctor maps them to the shared Perf Outcome IR. */
export interface ServiceCaseObservation {
  status: number | null;
  durationMs: number;
  events?: number;
  nbytes?: number;
  metrics?: Readonly<Record<string, number>>;
  meta?: Readonly<Record<string, unknown>>;
  errorKind?: string;
}

export interface ServiceCaseVerdict {
  ok: boolean;
  errorKind?: string;
}

export interface ServiceRequestIdentity {
  tenantId: string;
  userId: string;
}

/**
 * Declares that a Case needs tenant/user identity from a tenant directory.
 * The Plugin owns its profile schema; Core only fills missing identity interactively.
 */
export interface ServiceCaseIdentityRequirement {
  configured(config: Readonly<Record<string, unknown>>): Partial<ServiceRequestIdentity>;
}

/**
 * Service protocol adapter invoked concurrently by Core at Harness-owned dispatch points.
 * A runner must not create an independent load loop: request budgets, timing and cancellation
 * belong to Core so every Outcome remains attributable to one Trial and Window.
 */
export interface ServiceCaseRunner extends ProbeRunner<Case, ServiceCaseObservation> {
  /** Pure per-request protocol classification; aggregate Case/Perf judgment stays outside the runner. */
  classify(observation: ServiceCaseObservation): ServiceCaseVerdict;
}

export interface ServiceCaseProbeOptions {
  caseSetId: string;
  timeoutMs: number;
  requestIdentity?: ServiceRequestIdentity;
}

export interface ServicePerfObservability {
  metricServices: readonly string[];
  logServices: readonly string[];
  /** Ordered Outcome.meta keys accepted by the Service traceId resolver. */
  correlationKeys: readonly string[];
}

export interface ServicePerfCaseSelection {
  caseId: string;
  weight?: number;
}

export interface ServicePerfScenario {
  id: string;
  title: string;
  description: string;
  caseSetId: string;
  cases: readonly ServicePerfCaseSelection[];
  observability: ServicePerfObservability;
}

export interface ServiceInspectResolution {
  inputId: string;
  resolvedAs: string;
  /** Presentation-only identifiers. Query expansion consumes RelationFacts. */
  identifiers: Readonly<Record<string, string | undefined>>;
}

export interface ServiceInspectTruncation {
  reason: string;
  omittedFacts?: number;
}

/** Query-level outcome; acquisition state is not disguised as a domain Fact. */
export interface ServiceInspectResult<F extends Fact = Fact> extends InspectQueryResult<F> {
  resolution: ServiceInspectResolution;
  /** Optional sources that could not contribute to this otherwise collected result. */
  missingEvidence?: readonly string[];
  /** Explicitly records provider-side or Core-side capacity truncation. */
  truncated?: ServiceInspectTruncation;
}

export interface ServiceInspectBudget {
  maxFacts: number;
  maxBytes: number;
}

export type ServiceEvidenceRole = "supporting" | "contradicting" | "context";

export type ServiceEvidenceReference =
  | { observationId: string; role: ServiceEvidenceRole }
  | { factPath: string; role: ServiceEvidenceRole };

export type ServiceEvidenceProducer =
  | { origin: "core"; id: string }
  | { origin: "plugin"; plugin: string; service: string; id: string };

export interface ServiceFinding {
  id: string;
  kind: string;
  schemaVersion: number;
  severity: "info" | "warning" | "critical";
  confidence: "low" | "medium" | "high";
  message: string;
  /** Every business judgment names the persisted evidence that supports or qualifies it. */
  evidence: readonly ServiceEvidenceReference[];
  [name: string]: unknown;
}

/** One Core- or Plugin-produced Inspect Fact exposed to Service Probes and Detectors. */
export interface ServiceEvidenceFact {
  /** Path below the command Evidence `facts` root; valid as a Finding fact reference. */
  factPath: string;
  /** Logical Services this Fact describes; Core Facts may cover more than one Service. */
  services: readonly string[];
  kind: string;
  schemaVersion: number;
  producer: ServiceEvidenceProducer;
  /** Present when the Fact came from a Service Inspect query. */
  query?: Identity;
  value: unknown;
}

/** One Service-scoped Probe Observation exposed to pure business detectors. */
export interface ServiceEvidenceObservation<Value extends JsonObject = JsonObject> {
  /** Persisted Observation identity; valid as a Finding observation reference. */
  id: string;
  /** Logical Services this Observation describes. */
  services: readonly string[];
  probe: string;
  kind: string;
  schemaVersion: number;
  producer: ServiceEvidenceProducer;
  workload?: string;
  instance?: WorkloadInstance;
  value: Value;
}

/** Serializable, read-only projection of the Evidence selected for Service detectors. */
export interface ServiceEvidence {
  facts: readonly ServiceEvidenceFact[];
  observations: readonly ServiceEvidenceObservation[];
}

/** Pure business judgment over already collected Evidence; it never receives PluginContext. */
export interface ServiceDetector {
  id: string;
  detect(evidence: ServiceEvidence): readonly ServiceFinding[];
}

/** Core-built input shared by Service Probe capabilities after Inspect has settled. */
export interface ServiceProbeInput {
  /** Complete immutable Fact projection for this command; currently not filtered by Service or kind. */
  facts: readonly ServiceEvidenceFact[];
}

export interface ServiceWorkloadProbeInput extends ServiceProbeInput {
  instance: WorkloadInstance;
}

export interface ServiceInspectQuery extends Query<Identity> {
  budget: ServiceInspectBudget;
  results: ReadonlyMap<string, readonly ServiceInspectResult[]>;
}

/** Every requested identity has an outcome, including lookup failures. */
export type ServiceInspectQueryOutcome = { identity: Identity } & (
  | { status: "collected"; result: ServiceInspectResult }
  | { status: "failed"; reason: string }
);

/**
 * @spec Inspect accepts a Query list; an empty list performs no access and a singleton uses the same path
 * @spec Each Query retains its Identity, budget and outcome; lookup failures do not discard healthy siblings
 * @why Providers own shared preparation and source-specific access for the whole list
 */
export type ServiceInspectQueryHandler = (
  context: PluginContext,
  queries: readonly ServiceInspectQuery[],
) => Promise<readonly ServiceInspectQueryOutcome[]>;

export interface ServiceTraceIdInput {
  /** Opaque input ID. Providers decide whether it is a business ID or a trace ID. */
  bizId: string;
}

export interface ServiceTraceIdResolution {
  traceId: string;
  resolvedAs: string;
  /** Optional business record that directly carried this trace_id (for example a message ID). */
  sourceId?: string;
}

export type ServiceTraceIdResolutionResult =
  | ServiceTraceIdResolution
  | readonly ServiceTraceIdResolution[];

/** Service 构建与运行所使用的稳定工具链声明；现场版本仍由 Doctor 从 Target 观测。 */
export interface Toolchain {
  language: "python" | "go" | "javascript" | "typescript" | "java" | "kotlin";
  executionPlatform: "python" | "go-native" | "node" | "jvm";
  dependencyManager?:
  | "pip"
  | "poetry"
  | "uv"
  | "go-modules"
  | "npm"
  | "pnpm"
  | "yarn"
  | "maven"
  | "gradle";
  buildTool?: "go" | "tsc" | "vite" | "webpack" | "maven" | "gradle";
}

const TOOLCHAIN_VALUES = {
  language: new Set<string>(["python", "go", "javascript", "typescript", "java", "kotlin"]),
  executionPlatform: new Set<string>(["python", "go-native", "node", "jvm"]),
  dependencyManager: new Set<string>([
    "pip", "poetry", "uv", "go-modules", "npm", "pnpm", "yarn", "maven", "gradle",
  ]),
  buildTool: new Set<string>(["go", "tsc", "vite", "webpack", "maven", "gradle"]),
} as const;

/** Validate the optional Toolchain across the untyped Plugin ESM boundary. */
export function isToolchain(value: unknown): value is Toolchain {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.language === "string"
    && TOOLCHAIN_VALUES.language.has(candidate.language)
    && typeof candidate.executionPlatform === "string"
    && TOOLCHAIN_VALUES.executionPlatform.has(candidate.executionPlatform)
    && (candidate.dependencyManager === undefined
      || (typeof candidate.dependencyManager === "string"
        && TOOLCHAIN_VALUES.dependencyManager.has(candidate.dependencyManager)))
    && (candidate.buildTool === undefined
      || (typeof candidate.buildTool === "string" && TOOLCHAIN_VALUES.buildTool.has(candidate.buildTool)));
}

/** A Service-level reference to a DataSource declared by another Service. */
export interface ServiceDataSourceDependency {
  /** Stable local name used by this Service to consume the resolved dependency. */
  id: string;
  service: string;
  dataSource: string;
}


export interface ServiceRelationship {
  kind: "managed-by";
  service: string;
}

/** Doctor 跨 Plugin 共用的 Service 元描述；具体 Plugin 只声明身份和 capability。 */
export interface ServiceDefinition extends Omit<Service, "environment"> {
  /** Exact input synonyms for this whole Service, not Workload or telemetry selectors. */
  aliases?: readonly string[];
  /** Logical service responsibility; must not contain credentials or runtime configuration. */
  description?: string;
  relationships?: readonly ServiceRelationship[];
  toolchain?: Toolchain;
  /**
   * Runtime capabilities this Service requires from other Services in the same Plugin.
   * This stays Service-scoped because capability ownership and connection-config ownership may differ.
   */
  dependencies?: readonly ServiceDataSourceDependency[];
  /** Pure rules over the evidence selected by Collect. */
  detectors?: readonly ServiceDetector[];
  /** Declarations executed by Core environment probes. */
  environmentProbes?: readonly ServiceEnvironmentProbe[];
  /** Open, kind-based functions. A Service may provide several kinds. */
  extensions?: readonly RegisteredExtension[];
  dataSources?: readonly ServiceDataSource[];
  /** Explicit opt-in to configuration inspection. */
  configurationInspection?: boolean;
  /**
   * Presence enables log collection; default selects the implicit collection scope.
   * errorPatterns declares Service-specific error signatures that do not look like generic
   * errors (e.g. WARNING-level lines carrying business error codes); Core merges them into
   * --errors-only filtering. Invalid regex fails the log command explicitly at pattern build.
   */
  logs?: { default: boolean; errorPatterns?: readonly string[] };
}

/**
 * Bind an offline declaration to the environment selected for this invocation.
 * @rule Catalog discovery performs no I/O and never pins a profile or access credential.
 * @why Runtime Services use common's identity; only diagnostic extensions belong to Doctor.
 */
export function bindService<T extends ServiceDefinition, E extends Environment>(
  definition: T, environment: E,
): T & Service<E> {
  return { ...definition, environment };
}
