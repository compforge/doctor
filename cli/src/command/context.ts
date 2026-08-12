import {
  createKubernetesCommandContext,
  type KubernetesCommandContext,
} from "../infra/k8s/access";
import type { Executor } from "../infra/k8s/executor";
import {
  inspectDoctorHost,
  type DoctorHostInspection,
} from "./inspect/host";
import {
  inspectKubernetes,
  type KubernetesInspection,
} from "./inspect/kubernetes";
import type { Profile } from "./profile";

export interface CommandInspection {
  readonly host?: DoctorHostInspection;
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

/**
 * Shared execution state created once after CLI/profile resolution and before domain dispatch.
 * Collect and Provision consume the same immutable startup facts, command-scoped RBAC cache,
 * and user selections resolved for one semantic purpose.
 */
export class CommandContext {
  readonly #kubernetes = new WeakMap<Executor, KubernetesCommandContext>();
  readonly #selections = new Map<string, Promise<unknown>>();

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

  /** 同一命令内，同一目的的选择只向用户解析一次；失败允许后续阶段重试。 */
  resolveSelection<T>(key: string, resolve: () => Promise<T>): Promise<T> {
    const existing = this.#selections.get(key);
    if (existing) return existing as Promise<T>;

    const pending = Promise.resolve().then(resolve);
    this.#selections.set(key, pending);
    void pending.catch(() => {
      if (this.#selections.get(key) === pending) this.#selections.delete(key);
    });
    return pending;
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
    requirements.host ? inspectDoctorHost() : undefined,
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
