import { DEFAULT_POD_LOG_CAPTURE_POLICY } from "./log-policy";
import { ClientManager, type ClientProvider } from "@compforge/harness-toolbox/client-manager";
import { ConcurrencyPool } from "@compforge/harness-toolbox/concurrency";
import { PodLogByteBudget } from "@compforge/harness-toolbox/kubernetes/log-capture-plan";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import {
  createKubernetesCommandContext,
  type KubernetesCommandContext,
} from "../infra/k8s/access";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
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

export interface EnvironmentRequirements {
  readonly host?: boolean;
  readonly kubernetes?: boolean;
}

export interface CommandProfile {
  readonly name: string;
  readonly configPath: string;
  readonly value: Profile;
  readonly pluginConfig: Readonly<Record<string, unknown>>;
}

export interface CommandPluginServices {
  readonly name: string;
  readonly services: readonly string[];
}

export type CommandScope = readonly (string | number | boolean | null)[];

declare const commandDecisionValue: unique symbol;
declare const executionRecordValue: unique symbol;

/** A user or command-intent decision made at most once for the same semantic scope. */
export interface CommandDecision<Value> {
  readonly name: string;
  readonly [commandDecisionValue]: (value: Value) => Value;
}

/** An append-only intermediate result produced during command execution. */
export interface ExecutionRecord<Value> {
  readonly name: string;
  readonly [executionRecordValue]: (value: Value) => Value;
}

export function defineCommandDecision<Value>(name: string): CommandDecision<Value> {
  return Object.freeze({ name }) as unknown as CommandDecision<Value>;
}

export function defineExecutionRecord<Value>(name: string): ExecutionRecord<Value> {
  return Object.freeze({ name }) as unknown as ExecutionRecord<Value>;
}

function commandScopeKey(scope: CommandScope): string {
  return JSON.stringify(scope);
}

/**
 * Root-owned configuration for one execution tree. Domain inputs and per-call results stay outside it.
 */
export interface CommandContextOptions {
  format?: string;
  output?: string;
  plugin?: PluginDefinition;
  loadPlugin?: () => Promise<PluginDefinition | undefined>;
  onError?: (error: unknown, command: string) => void;
  environment?: { kubeconfig?: string; context?: string };
  signal?: AbortSignal;
}

/** Shared environment, Plugin, decisions and cancellation; each run owns its artifacts and temporary resources. */
export class CommandContext {
  readonly #controller = new AbortController();
  #pluginPromise?: Promise<PluginDefinition | undefined>;
  #hostPromise?: Promise<DoctorHostInfo>;
  #kubernetesPromise?: Promise<KubernetesInspection>;
  #plugin?: PluginDefinition;
  readonly signal: AbortSignal;
  readonly clients: ClientProvider;
  readonly #clients: ClientManager;

  /** One budget for the entire command tree, independent of the number of child collects. */
  readonly limits: { readonly podLogs: ConcurrencyPool; readonly podLogBytes: PodLogByteBudget };
  readonly artifacts = new CommandArtifacts();
  readonly #pluginServices = new Map<string, readonly string[]>();
  readonly #kubernetes = new WeakMap<Executor, KubernetesCommandContext>();
  readonly #decisions = new Map<object, Map<string, Promise<unknown>>>();
  readonly #runs = new Map<object, Map<string, Promise<unknown>>>();
  readonly #executionRecords = new Map<object, Map<string, unknown[]>>();

  constructor(
    readonly inspection: CommandInspection,
    readonly profile: CommandProfile = {
      name: "default",
      configPath: "",
      value: { readonly: true },
      pluginConfig: {},
    },
    readonly options: CommandContextOptions = {},
  ) {
    this.limits = { podLogBytes: new PodLogByteBudget(DEFAULT_POD_LOG_CAPTURE_POLICY.maxTotalBytes), podLogs: new ConcurrencyPool(profile.value.log?.concurrency ?? DEFAULT_POD_LOG_CAPTURE_POLICY.concurrency) };
    this.#plugin = options.plugin;
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.#controller.signal]) : this.#controller.signal;
    this.#clients = new ClientManager(this.signal);
    this.clients = { get: source => this.#clients.get(source) };
  }

  /** Root finalize owns this operation; child commands only borrow clients. */
  disposeClients(): Promise<void> { return this.#clients.dispose(); }

  get plugin(): PluginDefinition {
    if (!this.#plugin) throw new Error("This command requires a loaded Plugin");
    return this.#plugin;
  }

  get pluginIdentity(): string | undefined {
    return this.#plugin ? `${this.#plugin.id}@${this.#plugin.version}` : undefined;
  }

  cancel(reason: unknown = new Error("Command cancelled")): void { this.#controller.abort(reason); }

  async resolvePlugin(): Promise<PluginDefinition | undefined> {
    this.#pluginPromise ??= (async () => {
      const plugin = this.#plugin ?? await this.options.loadPlugin?.();
      this.#plugin = plugin;
      plugin?.validateConfig?.(this.profile.pluginConfig);
      if (plugin) this.registerPluginServices(plugin.id, plugin.services.services.map((service) => service.name));
      return plugin;
    })();
    return this.#pluginPromise;
  }

  async ensureEnvironment(requirements: EnvironmentRequirements): Promise<void> {
    const [host, kubernetes] = await Promise.all([
      requirements.host ? this.inspection.host ?? (this.#hostPromise ??= Promise.resolve(getDoctorHostInfo())) : undefined,
      requirements.kubernetes ? this.inspection.kubernetes ?? (this.#kubernetesPromise ??= inspectKubernetes(
        this.options.environment ?? {}, this.profile,
      )) : undefined,
    ]);
    if (requirements.kubernetes && !kubernetes?.channel.available) {
      throw new Error(kubernetes?.channel.reason ?? "Kubernetes environment preparation failed");
    }
    Object.assign(this.inspection, {
      ...(host ? { host } : {}), ...(kubernetes ? { kubernetes } : {}),
    });
  }

  kubernetes(executor: Executor): KubernetesCommandContext {
    let context = this.#kubernetes.get(executor);
    if (!context) {
      context = createKubernetesCommandContext(executor);
      this.#kubernetes.set(executor, context);
    }
    return context;
  }

  registerPluginServices(name: string, services: readonly string[]): void {
    const existing = this.#pluginServices.get(name);
    const normalized = [...new Set(services)].sort();
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) {
      throw new Error(`Plugin '${name}' 的 Service Catalog 已注册且内容不一致`);
    }
    this.#pluginServices.set(name, normalized);
  }

  pluginServices(): readonly CommandPluginServices[] {
    return [...this.#pluginServices].map(([name, services]) => ({ name, services }));
  }

  /** 同一类型、同一作用域只决策一次；取消等正常结果也会被后续步骤复用。 */
  decide<Value>(
    type: CommandDecision<Value>,
    scope: CommandScope,
    decide: () => Value | Promise<Value>,
  ): Promise<Value> {
    return this.#memoize(this.#decisions, type, scope, decide);
  }

  /** Same command and declared scope share one completed result, including partial/failed evidence. */
  runIdempotent<Value>(command: object, key: string, run: () => Promise<Value>, onReuse: () => void): Promise<Value> {
    if (this.#runs.get(command)?.has(commandScopeKey([key]))) onReuse();
    // Publish the promise before work starts, so concurrent callers also share cleanup and artifacts.
    return this.#memoize(this.#runs, command, [key], run);
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
  requirements: EnvironmentRequirements,
): Promise<CommandContext> {
  const context = new CommandContext({}, profile, { environment: opts });
  await context.ensureEnvironment(requirements);
  return context;
}
