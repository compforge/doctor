import {
  hostProcessToolkitChannel,
  resolveDevelopmentToolkitTool,
  resolveToolkitBundle,
} from "../toolkit";

export const PYDUMP_ANALYSIS_VERSION = "0.1.0";

/** Resolve the standalone analyzer that executes directly on Doctor Host. */
export function resolveHostPydumpAnalyzer(): string {
  const channel = hostProcessToolkitChannel();
  if (!channel) throw new Error("Doctor Host 平台不支持 Python heap analyzer");
  const resolved = resolveToolkitBundle(channel, {
    id: "pydump-analysis",
    protocol: "pydump.analysis/v1",
  });
  return resolved?.components.analyzer?.path
    ?? resolveDevelopmentToolkitTool("pydump-analyzer", channel.platform)
    ?? (() => { throw new Error("Doctor Toolkit 缺少 Host Python heap analyzer"); })();
}

export function localPydumpRetainedArgv(
  analyzerFile: string,
  heapFile: string,
  topN = 100,
): string[] {
  return [
    analyzerFile,
    "retained-heap",
    "--file",
    heapFile,
    "--top-n",
    String(topN),
    "--format",
    "json",
  ];
}
