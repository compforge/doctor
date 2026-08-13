import type { ExecResult, Executor } from "../../k8s/executor";

export const DOCTOR_DEBUG_CONTAINER_PREFIX = "doctor-debug-";
export const DOCTOR_DEBUG_MANIFEST = "/opt/doctor/manifest.json";
/** Supported capabilities; deployment defaults remain the narrower set in provision/debug/capabilities. */
export const DEBUG_CAPABILITIES = ["SYS_PTRACE", "NET_RAW", "NET_ADMIN"] as const;
export type DebugCapability = typeof DEBUG_CAPABILITIES[number];

export interface EphemeralDebugEnvironmentFact {
  kind: "ephemeral-container";
  executionContainer: string;
  image: string;
  targetContainer: string;
  state: "running" | "waiting" | "terminated" | "unknown";
  capabilities: string[];
  compatible: boolean;
  reason?: string;
}

/** Public environment fact; additional preparation routes extend this union. */
export type DebugEnvironmentFact = EphemeralDebugEnvironmentFact;

export interface DebugEnvironmentFacts {
  environments: DebugEnvironmentFact[];
  selected?: DebugEnvironmentFact;
  reason?: string;
}

export type DebugEnvironmentResolution =
  | { ok: true; value: DebugEnvironmentFact }
  | { ok: false; reason: string };

export interface DebugPreparationOptions {
  namespace: string;
  podName: string;
  podJson: string;
  targetContainer: string;
  environmentName: string;
  image: string;
  capabilities: readonly DebugCapability[];
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  command?: readonly string[];
  timeoutMs?: number;
}

export interface DebugTargetImageKeepalive {
  command: string[];
  description: string;
}

export interface DebugGdbFact {
  available: boolean;
  pythonScripting: boolean;
  inferiorCall: boolean;
  version?: string;
  reason?: string;
}

export interface DebugPreparationPreflight {
  runnable: boolean;
  reason?: string;
}

/** A preparation plan keeps preflight and execution bound to the same target description. */
export interface DebugPreparation {
  readonly route: "ephemeral-container";
  preflight(): Promise<DebugPreparationPreflight>;
  execute(): Promise<ExecResult>;
  waitUntilReady(): Promise<ExecResult>;
}

/**
 * Target-side debug environment engine.
 *
 * Ephemeral containers are the current Kubernetes route, but callers depend on
 * environment facts and preparation rather than that route's mutation details.
 */
export interface DebugEngine {
  inspectEnvironments(podJson: string, targetContainer: string): DebugEnvironmentFact[];
  resolveEnvironment(
    facts: readonly DebugEnvironmentFact[],
    requiredCapabilities?: readonly DebugCapability[],
  ): DebugEnvironmentResolution;
  inspect(podJson: string, targetContainer: string): DebugEnvironmentFacts;
  inspectReadiness(exec: Executor, pod: string, container: string): Promise<ExecResult>;
  resolveTargetImageKeepalive(
    exec: Executor,
    pod: string,
    container: string,
  ): Promise<DebugTargetImageKeepalive | undefined>;
  inspectGdb(exec: Executor, pod: string, container: string): Promise<DebugGdbFact>;
  planPreparation(
    exec: Executor,
    options: DebugPreparationOptions,
  ): DebugPreparation;
}
