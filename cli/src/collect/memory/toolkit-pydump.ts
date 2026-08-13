import {
  hostProcessToolkitChannel,
  kubernetesToolkitChannel,
  resolveDevelopmentToolkitTool,
  resolveToolkitResource,
} from "../../infra/toolkit";

function resolveTool(
  channel: NonNullable<ReturnType<typeof hostProcessToolkitChannel>>,
  id: string,
): string | undefined {
  return resolveToolkitResource(channel, "tool", id)?.path
    ?? resolveDevelopmentToolkitTool(id, channel.platform);
}

/** Resolve the standalone Go analyzer that executes directly on Doctor Host. */
export function resolveHostPydumpAnalyzer(): string {
  const channel = hostProcessToolkitChannel();
  if (!channel) throw new Error("Doctor Host 平台不支持 Pydump analyzer");
  return resolveTool(channel, "pydump-analyzer")
    ?? (() => { throw new Error("Doctor Toolkit 缺少 Host Pydump analyzer"); })();
}

export interface KubernetesPydumpCaptureTools {
  collector: string;
  agent: string;
}

/** Resolve the Collector and runtime-compatible Agent for the execution container. */
export function resolveKubernetesPydumpCaptureTools(input: {
  pod: string;
  container: string;
  architecture: string;
  pythonMinor: string;
  minGlibcVersion: string;
}): KubernetesPydumpCaptureTools {
  const channel = kubernetesToolkitChannel(input);
  if (!channel) throw new Error(`Target architecture 不支持：${input.architecture}`);
  const collector = resolveTool(channel, "pydump-collector");
  const agent = resolveTool(
    channel,
    `pydump-agent-${input.pythonMinor}-min-glibc-${input.minGlibcVersion}`,
  );
  if (!collector || !agent) {
    throw new Error(
      `Doctor Toolkit 缺少 ${channel.platform.os}/${channel.platform.architecture} `
      + `Pydump Collector 或 CPython ${input.pythonMinor} / 最低 glibc ${input.minGlibcVersion} Agent`,
    );
  }
  return { collector, agent };
}
