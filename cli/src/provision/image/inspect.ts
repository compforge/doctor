import {
  discoverRegistryCatalog,
} from "../../app/image-target";
import { resolveCollectKubeconfig } from "../../infra/k8s/context";
import { KubectlExecutor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../../command";

import { useLogger } from "../../terminal/log";
import type { ImageCliOpts } from "./model";

export async function discoverImageRegistryCatalog(
  opts: ImageCliOpts,
  commandContext: CommandContext,
) {
  const resolved = resolveCollectKubeconfig(opts, commandContext.profile);
  const executor = new KubectlExecutor({
    kubeconfig: resolved.kubeconfig,
    context: opts.context,
  });
  const kubernetes = commandContext.kubernetes(executor);
  useLogger("k8s").info(`Doctor Host -> Kubernetes: kubeconfig=${resolved.source}`);
  const channel = commandContext.inspection.kubernetes?.channel;
  if (!channel) throw new Error("doctor image requires Kubernetes startup inspection");
  if (!channel.available) {
    throw new Error(channel.reason ?? "Kubernetes 通道不可用");
  }
  useLogger("k8s").success("Kubernetes API Server 可达");
  return discoverRegistryCatalog(opts, kubernetes.executor, {
    access: kubernetes.access,
    channelChecked: true,
    profile: commandContext.profile,
  });
}
