import type { PluginIdentity } from "@compforge/doctor-plugin";

// 单一运行时版本号来源；使用 `make bump-version` 与 package.json 同步更新。
export const DOCTOR_CLI_VERSION = "0.1.3";

export function formatDoctorVersion(plugin?: PluginIdentity): string {
  return [
    `doctor ${DOCTOR_CLI_VERSION} (${process.platform}-${process.arch})`,
    `plugin ${plugin ? `${plugin.id}@${plugin.version}` : "none"}`,
  ].join("\n");
}
