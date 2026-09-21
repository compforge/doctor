import type { PluginIdentity } from "@compforge/doctor-plugin";
import type { DoctorHostInfo } from "../infra/host";
import type { Distribution } from "./distribution";

// Doctor Core 的唯一版本事实源；运行时和构建流程都读取这里。
export const DOCTOR_CLI_VERSION = "0.1.137";

export function formatDistributionVersion(distribution: Distribution = {}): string {
  return `${distribution.name ?? "doctor"} ${distribution.version ?? DOCTOR_CLI_VERSION}`;
}

export function formatDoctorVersion(
  plugin: PluginIdentity | undefined,
  host?: DoctorHostInfo,
  distribution: Distribution = {},
): string {
  const release = formatDistributionVersion(distribution);
  const core = `doctor ${DOCTOR_CLI_VERSION}`;
  return [
    release,
    ...(release === core ? [] : [core]),
    `plugin ${plugin ? `${plugin.id}@${plugin.version}` : "none"}`,
    ...(host ? [
      `os ${host.platform} ${host.kernelRelease}`,
      `arch ${host.architecture}`,
      `glibc ${host.platform === "linux" ? host.glibcVersion ?? "unknown" : "n/a"}`,
    ] : []),
  ].join("\n");
}
