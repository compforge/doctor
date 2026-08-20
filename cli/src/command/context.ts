import {
  createKubernetesCommandContext,
  type KubernetesCommandContext,
} from "../infra/k8s/access";
import type { Executor } from "../infra/k8s/executor";
import {
  getDoctorHostInfo,
  type DoctorHostInfo,
} from "../infra/host/info";
import {
  inspectKubernetes,
  type KubernetesInspection,
} from "./inspect/kubernetes";
import type { Profile } from "./profile";
import { CommandArtifacts } from "./artifacts";

export interface CommandInspection {
  readonly host?: DoctorHostInfo;
  readonly kubernetes?: KubernetesInspection;
}

export interface CommandEnvironmentRequirements {
  readonly host?: boolean;
  readonly kubernetes?: boolean;
}

export interface CommandProfile {
  readonly name: string;
  readonly configPath: string;
  readonly value: Profile;
  readonly pluginConfig: Readonly<Record<string, unknown>>;
}

export type CommandScope = readonly (string | number | boolean | null)[];

declare const commandDecisionValue: unique symbol;
declare const commandDiscoveryValue: unique symbol;
declare const executionRecordValue: unique symbol;

/** A user or command-intent decision made at most once for the same semantic scope. */
export interface CommandDecision<Value> {
  readonly name: string;
  readonly [commandDecisionValue]: (value: Value) => Value;
}

/** A read-only runtime discovery reused within the same semantic scope. */
export interface CommandDiscovery<Value> {
  readonly name: string;
  readonly [commandDiscoveryValue]: (value: Value) => Value;
}

/** An append-only intermediate result produced during command execution. */
export interface ExecutionRecord<Value> {
  readonly name: string;
  readonly [executionRecordValue]: (value: Value) => Value;
}

export function defineCommandDecision<Value>(name: string): CommandDecision<Value> {
  return Object.freeze({ name }) as unknown as CommandDecision<Value>;
}

export function defineCommandDiscovery<Value>(name: string): CommandDiscovery<Value> {
  return Object.freeze({ name }) as unknown as CommandDiscovery<Value>;
}

export function defineExecutionRecord<Value>(name: string): ExecutionRecord<Value> {
  return Object.freeze({ name }) as unknown as ExecutionRecord<Value>;
}

function commandScopeKey(scope: CommandScope): string {
  return JSON.stringify(scope);
}

/**
 * Shared execution state created once after CLI/profile resolution and before domain dispatch.
 * Collect and Provision consume the same immutable startup facts, command-scoped RBAC cache,
 * memoized decisions/discoveries, and append-only execution records produced by later steps.
 */
export class CommandContext {
  readonly artifacts = new CommandArtifacts();
  readonly #kubernetes = new WeakMap<Executor, KubernetesCommandContext>();
  readonly #decisions = new Map<object, Map<string, Promise<unknown>>>();
  readonly #discoveries = new Map<object, Map<string, Promise<unknown>>>();
  readonly #executionRecords = new Map<object, Map<string, unknown[]>>();

  constructor(
    readonly inspection: CommandInspection,
    readonly profile: CommandProfile = {
      name: "default",
      configPath: "",
      value: { readonly: true },
      pluginConfig: {},
    },
  ) {}

  kubernetes(executor: Executor): KubernetesCommandContext {
    let context = this.#kubernetes.get(executor);
    if (!context) {
      context = createKubernetesCommandContext(executor);
      this.#kubernetes.set(executor, context);
    }
    return context;
  }

  /** 同一类型、同一作用域只决策一次；取消等正常结果也会被后续步骤复用。 */
  decide<Value>(
    type: CommandDecision<Value>,
    scope: CommandScope,
    decide: () => Value | Promise<Value>,
  ): Promise<Value> {
    return this.#memoize(this.#decisions, type, scope, decide);
  }

  /** 同一类型、同一作用域只发现一次；异常不会污染后续步骤，可再次探测。 */
  discover<Value>(
    type: CommandDiscovery<Value>,
    scope: CommandScope,
    inspect: () => Value | Promise<Value>,
  ): Promise<Value> {
    return this.#memoize(this.#discoveries, type, scope, inspect);
  }

  #memoize<Value>(
    store: Map<object, Map<string, Promise<unknown>>>,
    type: object,
    scope: CommandScope,
    resolve: () => Value | Promise<Value>,
  ): Promise<Value> {
    const scoped = store.get(type) ?? new Map<string, Promise<unknown>>();
    store.set(type, scoped);
    const key = commandScopeKey(scope);
    const existing = scoped.get(key);
    if (existing) return existing as Promise<Value>;

    const pending = Promise.resolve().then(resolve);
    scoped.set(key, pending);
    void pending.catch(() => {
      if (scoped.get(key) === pending) scoped.delete(key);
    });
    return pending;
  }

  /** Record an intermediate result without turning it into persistent state or Collect Evidence. */
  record<Value>(type: ExecutionRecord<Value>, scope: CommandScope, value: Value): void {
    const scoped = this.#executionRecords.get(type) ?? new Map<string, unknown[]>();
    this.#executionRecords.set(type, scoped);
    const key = commandScopeKey(scope);
    const records = scoped.get(key) ?? [];
    records.push(value);
    scoped.set(key, records);
  }

  records<Value>(type: ExecutionRecord<Value>, scope: CommandScope): readonly Value[] {
    const values = this.#executionRecords.get(type)?.get(commandScopeKey(scope)) ?? [];
    return [...values] as Value[];
  }

  latestRecord<Value>(
    type: ExecutionRecord<Value>,
    scope: CommandScope,
  ): Value | undefined {
    return this.#executionRecords.get(type)?.get(commandScopeKey(scope))?.at(-1) as Value | undefined;
  }
}

/** Production commands reuse startup state; injected tests can construct a local fallback. */
export function resolveKubernetesCommandContext(
  executor: Executor,
  commandContext?: CommandContext,
): KubernetesCommandContext {
  return commandContext?.kubernetes(executor)
    ?? createKubernetesCommandContext(executor);
}

export async function prepareCommandContext(
  opts: {
    kubeconfig?: string;
    context?: string;
  },
  profile: CommandProfile,
  requirements: CommandEnvironmentRequirements,
): Promise<CommandContext> {
  const [host, kubernetes] = await Promise.all([
    requirements.host ? getDoctorHostInfo() : undefined,
    requirements.kubernetes ? inspectKubernetes(opts, profile) : undefined,
  ]);
  if (requirements.kubernetes && !kubernetes?.channel.available) {
    throw new Error(kubernetes?.channel.reason ?? "Kubernetes environment preparation failed");
  }
  return new CommandContext(
    { host, kubernetes },
    profile,
  );
}
