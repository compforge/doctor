import type { ToolkitArchitecture, ToolkitChannel } from "./model";

export function normalizeToolkitArchitecture(
  value: string | undefined,
): ToolkitArchitecture | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "amd64" || normalized === "x64" || normalized === "x86_64") return "amd64";
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  return undefined;
}

export function hostProcessToolkitChannel(): ToolkitChannel | undefined {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  const architecture = normalizeToolkitArchitecture(process.arch);
  return architecture
    ? { kind: "host-process", platform: { os: process.platform, architecture } }
    : undefined;
}

export function hostContainerToolkitChannel(
  architecture = normalizeToolkitArchitecture(process.arch),
): ToolkitChannel | undefined {
  return architecture
    ? { kind: "host-container", platform: { os: "linux", architecture } }
    : undefined;
}

export function kubernetesToolkitChannel(input: {
  pod: string;
  container: string;
  architecture?: string;
}): ToolkitChannel | undefined {
  const architecture = normalizeToolkitArchitecture(input.architecture);
  return architecture
    ? {
      kind: "kubernetes-container",
      platform: { os: "linux", architecture },
      pod: input.pod,
      container: input.container,
    }
    : undefined;
}
