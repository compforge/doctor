import coreVersion from "../../../VERSION" with { type: "text" };
import type { PluginIdentity } from "@compforge/doctor-plugin";
import type { DoctorHostInfo } from "../infra/host";
import type { Distribution } from "./distribution";

// +spec=Core version comes from the root VERSION and is embedded in built artifacts.
// +why=Version bumps change metadata without rewriting source or requiring a runtime file.
export const DOCTOR_CLI_VERSION = coreVersion.trim();

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
