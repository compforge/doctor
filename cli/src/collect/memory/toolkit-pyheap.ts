import {
  hostProcessToolkitChannel,
  kubernetesToolkitChannel,
  resolveDevelopmentToolkitTool,
  resolveToolkitResource,
} from "../../infra/toolkit";

export type PyHeapToolkitTool = "dumper" | "analyzer";

function toolId(tool: PyHeapToolkitTool): "pyheap-dumper" | "pyheap-analyzer" {
  return tool === "dumper" ? "pyheap-dumper" : "pyheap-analyzer";
}

/** Resolve a PyHeap tool that executes directly on Doctor Host. */
export function resolveHostPyHeapTool(tool: PyHeapToolkitTool): string {
  const channel = hostProcessToolkitChannel();
  if (!channel) throw new Error(`Doctor Host 平台不支持 PyHeap ${tool}`);
  return resolveToolkitResource(channel, "tool", toolId(tool))?.path
    ?? resolveDevelopmentToolkitTool(toolId(tool), channel.platform)
    ?? (() => { throw new Error(`Doctor Toolkit 缺少 Host PyHeap ${tool}`); })();
}

/** Resolve a dumper for the Kubernetes container where the PEX will actually execute. */
export function resolveKubernetesPyHeapDumper(input: {
  pod: string;
  container: string;
  architecture: string;
}): string {
  const channel = kubernetesToolkitChannel(input);
  if (!channel) throw new Error(`Target architecture 不支持：${input.architecture}`);
  return resolveToolkitResource(channel, "tool", "pyheap-dumper")?.path
    ?? resolveDevelopmentToolkitTool("pyheap-dumper", channel.platform)
    ?? (() => {
      throw new Error(
        `Doctor Toolkit 缺少 ${channel.platform.os}/${channel.platform.architecture} PyHeap dumper`,
      );
    })();
}
