import type { PluginIdentity } from "@compforge/doctor-plugin";

// Doctor Core 的唯一版本事实源；运行时和构建流程都读取这里。
export const DOCTOR_CLI_VERSION = "0.1.33";

export function formatDoctorVersion(plugin?: PluginIdentity): string {
  return [
    `doctor ${DOCTOR_CLI_VERSION} (${process.platform}-${process.arch})`,
    `plugin ${plugin ? `${plugin.id}@${plugin.version}` : "none"}`,
  ].join("\n");
}
