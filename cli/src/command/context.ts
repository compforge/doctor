import type { WorkingProfileOptions } from "../app/profile";
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

export interface CommandInspection {
  readonly host: DoctorHostInspection;
  readonly kubernetes: KubernetesInspection;
}

/**
 * Shared execution state created once after CLI/profile resolution and before domain dispatch.
 * Collect and Provision consume the same immutable startup facts and command-scoped RBAC cache.
 */
export class CommandContext {
  readonly #kubernetes = new WeakMap<Executor, KubernetesCommandContext>();

  constructor(readonly inspection: CommandInspection) {}

  kubernetes(executor: Executor): KubernetesCommandContext {
    let context = this.#kubernetes.get(executor);
    if (!context) {
      context = createKubernetesCommandContext(executor);
      this.#kubernetes.set(executor, context);
    }
    return context;
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

export async function inspectCommandContext(
  opts: WorkingProfileOptions & {
    kubeconfig?: string;
    context?: string;
  },
): Promise<CommandContext> {
  const [host, kubernetes] = await Promise.all([
    inspectDoctorHost(),
    inspectKubernetes(opts),
  ]);
  return new CommandContext({ host, kubernetes });
}
