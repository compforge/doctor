import type { DbDiscovery } from "./discovery";
import type { ProviderResolution } from "./providers";

function cell(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\|/g, "\\|");
}

/** Discovery is runtime evidence; descriptions explain declarations, not availability or permissions. */
export function databaseDiscoverySummary(discovery: readonly DbDiscovery[], failures: ProviderResolution["failures"]): string {
  const lines = ["| DataSource | Database | Description | 状态 |", "| --- | --- | --- | --- |"];
  for (const { provider, result, error } of discovery) {
    const databases = (result?.rows ?? []).map(row => row.database_name ?? row.Database).filter((name): name is string => typeof name === "string");
    const state = error ?? (result?.truncated ? "partial（清单截断）" : databases.length ? "ok" : "未发现可见数据库");
    for (const source of provider.dataSources) {
      for (const database of databases.length ? databases : ["—"]) {
        lines.push(`| ${cell(source.id)} | ${cell(database)} | ${cell(source.description ?? "—")} | ${cell(state)} |`);
      }
    }
  }
  for (const failure of failures) {
    lines.push(`| ${cell(failure.id)} | — | ${cell(failure.description ?? "—")} | ${cell(failure.reason)} |`);
  }
  return lines.join("\n");
}
