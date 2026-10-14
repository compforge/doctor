import type { ServiceDatabaseDataSource, ServiceDatabaseTarget } from "@compforge/doctor-plugin";
import type { Database } from "../../../infra/database/mysql";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { EvidenceBundle } from "../../evidence";
import type { StoreConfig } from "../config";
import type { CommandContext } from "../../../command";

export interface DbCommandContext {
  command: CommandContext;
  executor: Executor;
  config: StoreConfig;
  capability: ServiceDatabaseDataSource;
  bundle: EvidenceBundle;
  target?: ServiceDatabaseTarget;
  database?: Database;
  log: (line: string) => void;
}
