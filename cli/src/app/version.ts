import type { PluginIdentity } from "@compforge/doctor-plugin";
import type { DoctorHostInfo } from "../infra/host";

// Doctor Core 的唯一版本事实源；运行时和构建流程都读取这里。
export const DOCTOR_CLI_VERSION = "0.1.49";

export function formatDoctorVersion(
  plugin: PluginIdentity | undefined,
  host?: DoctorHostInfo,
  kubernetesVersion?: string,
): string {
  return [
    `doctor ${DOCTOR_CLI_VERSION}`,
    `plugin ${plugin ? `${plugin.id}@${plugin.version}` : "none"}`,
    ...(host ? [
      `os ${host.platform} ${host.kernelRelease}`,
      `arch ${host.architecture}`,
      `glibc ${host.platform === "linux" ? host.glibcVersion ?? "unknown" : "n/a"}`,
    ] : []),
    ...(kubernetesVersion ? [`kubernetes ${kubernetesVersion}`] : []),
  ].join("\n");
}
