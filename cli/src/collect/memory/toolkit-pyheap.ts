import {
  kubernetesToolkitChannel,
  resolveDevelopmentToolkitTool,
  resolveToolkitResource,
} from "../../infra/toolkit";

/** Resolve the optional fork-pyheap dumper for its actual Kubernetes execution container. */
export function resolveKubernetesPyHeapDumper(input: {
  pod: string;
  container: string;
  architecture: string;
}): string {
  const channel = kubernetesToolkitChannel(input);
  if (!channel) throw new Error(`Target architecture 不支持：${input.architecture}`);
  return resolveToolkitResource(channel, "tool", "fork-pyheap-dumper")?.path
    ?? resolveDevelopmentToolkitTool("fork-pyheap-dumper", channel.platform)
    ?? (() => {
      throw new Error(
        `Doctor Toolkit 缺少 ${channel.platform.os}/${channel.platform.architecture} fork-pyheap dumper`,
      );
    })();
}
