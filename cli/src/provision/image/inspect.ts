import {
  discoverRegistryCatalog,
} from "../../app/image-target";
import { resolveCollectKubeconfig } from "../../infra/k8s/context";
import { KubectlExecutor } from "../../infra/k8s/executor";
import type { CommandContext } from "../../command";
import { terminalStdout } from "../../terminal/output";
import type { ImageCliOpts } from "./model";

export async function discoverImageRegistryCatalog(
  opts: ImageCliOpts,
  commandContext: CommandContext,
) {
  const resolved = resolveCollectKubeconfig(opts);
  const executor = new KubectlExecutor({
    kubeconfig: resolved.kubeconfig,
    context: opts.context,
  });
  const kubernetes = commandContext.kubernetes(executor);
  terminalStdout.write(
    `[k8s] Doctor Host -> Kubernetes: kubeconfig=${resolved.source}\n`,
  );
  const channel = commandContext.inspection.kubernetes.channel;
  if (!channel.available) {
    throw new Error(channel.reason ?? "Kubernetes 通道不可用");
  }
  terminalStdout.success("[k8s] Kubernetes API Server 可达\n");
  return discoverRegistryCatalog(opts, kubernetes.executor, {
    access: kubernetes.access,
    channelChecked: true,
  });
}
