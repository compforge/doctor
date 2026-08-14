import type { ExecResult, ExecTarget, Executor } from "../k8s/executor";
import type { ContainerInfo } from "../k8s/target";
import type { DebugEnvironmentFact } from "../target/debug";

export type HeapDumpBackendKind = "pydump" | "pyheap";
export type HeapDumpStrategy = "debug-container" | "target-container";

export interface HeapDumpExecution {
  readonly strategy: HeapDumpStrategy;
  readonly target: ExecTarget;
  readonly container: string;
  readonly label: string;
}

export interface HeapDumpBackendObservation {
  readonly id: string;
  readonly title: string;
  readonly result?: ExecResult;
  readonly status?: "ok" | "failed";
  readonly reason?: string;
  readonly output?: string;
  readonly effect?: "observe" | "overhead";
}

export interface HeapDumpBackendContext {
  readonly executor: Executor;
  readonly pod: string;
  readonly podJson: string;
  readonly targetContainer: ContainerInfo;
  readonly pid: number;
  observe(observation: HeapDumpBackendObservation): void;
  verifyPtrace(execution: HeapDumpExecution): Promise<string | undefined>;
}

export type HeapDumpBackendResult<T> =
  | { readonly value: T }
  | { readonly reason: string };

export interface HeapDumpRuntime<State> {
  readonly state: State;
  readonly summary: readonly string[];
  readonly facts: Readonly<Record<string, unknown>>;
}

export interface PreparedHeapDump<State> {
  readonly state: State;
  readonly version?: string;
  readonly summary?: readonly string[];
  readonly facts?: Readonly<Record<string, unknown>>;
}

/**
 * Target-side heap dumper lifecycle. The generic states stay private to each backend while the
 * capture coordinator owns confirmation, guards, Evidence and artifact delivery.
 */
export interface HeapDumpBackend<
  Execution extends HeapDumpExecution,
  RuntimeState,
  PreparedState,
> {
  readonly kind: HeapDumpBackendKind;
  readonly displayName: string;
  readonly logName: string;
  readonly toolDir: string;
  readonly version: string;
  readonly confirmationWarning?: string;
  readonly cleanupCommand: () => string[];
  prepareDebugExecution(
    context: HeapDumpBackendContext,
    debug: DebugEnvironmentFact,
  ): Promise<HeapDumpBackendResult<Execution>>;
  prepareTargetExecution(
    context: HeapDumpBackendContext,
  ): Promise<HeapDumpBackendResult<Execution>>;
  inspectRuntime(
    context: HeapDumpBackendContext,
    execution: Execution,
  ): Promise<HeapDumpBackendResult<HeapDumpRuntime<RuntimeState>>>;
  prepare(
    context: HeapDumpBackendContext,
    execution: Execution,
    runtime: RuntimeState,
  ): Promise<HeapDumpBackendResult<PreparedHeapDump<PreparedState>>>;
  dumpCommand(input: {
    execution: Execution;
    runtime: RuntimeState;
    prepared: PreparedState;
    pid: number;
    heapFile: string;
    strReprLen: number;
    noAttribute: boolean;
  }): string[];
  failureReason(result: ExecResult): string;
}
