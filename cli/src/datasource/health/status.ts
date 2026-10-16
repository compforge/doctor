import { CommandStatus } from "../../command/status";
import type { DataSourceHealthResult } from "./extension";
export function dataSourceHealthStatus(health: DataSourceHealthResult): CommandStatus {
  return health.status === "ok" ? CommandStatus.Ok : health.status === "partial" ? CommandStatus.Partial : CommandStatus.Failed;
}
