import type { WorkingProfileOptions } from "../../app/profile";
import {
  inspectKubernetesChannel,
  type KubernetesChannelFact,
} from "../../infra/k8s/access";
import {
  resolveCollectKubeconfig,
  type ResolvedKubeconfig,
} from "../../infra/k8s/context";
import {
  KubectlExecutor,
  type ExecResult,
} from "../../infra/k8s/executor";

export interface KubernetesInspection {
  readonly kubeconfig: ResolvedKubeconfig;
  readonly context?: string;
  readonly channel: KubernetesChannelFact;
}

function unresolvedChannel(reason: string): KubernetesChannelFact {
  const client: ExecResult = {
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: reason,
    durationMs: 0,
    timedOut: false,
    command: ["kubectl"],
  };
  return { available: false, client, reason };
}

/** Probe the command's resolved Kubernetes transport once, before domain dispatch. */
export async function inspectKubernetes(
  opts: WorkingProfileOptions & {
    kubeconfig?: string;
    context?: string;
  },
  profile?: import("../context").CommandProfile,
): Promise<KubernetesInspection> {
  let kubeconfig: ResolvedKubeconfig;
  try {
    kubeconfig = resolveCollectKubeconfig(opts, profile);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kubeconfig: { source: "unresolved" },
      context: opts.context,
      channel: unresolvedChannel(reason),
    };
  }
  const executor = new KubectlExecutor({
    kubeconfig: kubeconfig.kubeconfig,
    context: opts.context,
  });
  return {
    kubeconfig,
    context: opts.context,
    channel: await inspectKubernetesChannel(executor),
  };
}
