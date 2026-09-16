import type { ServiceDatabaseDataSource } from "@compforge/doctor-plugin";
import type { DatabaseTarget } from "../../../infra/database";
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
  target?: DatabaseTarget;
  database?: Database;
  log: (line: string) => void;
}
