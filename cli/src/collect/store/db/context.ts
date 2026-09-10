import type { ServiceDatabaseStoreCapability } from "@compforge/doctor-plugin";
import type { DatabaseTarget } from "../../../infra/database";
import type { Database } from "../../../infra/database/mysql";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { EvidenceBundle } from "../../evidence";
import type { PodStoreConfig } from "../config";
import type { CommandContext } from "../../../command";

export interface DbCommandContext {
  command: CommandContext;
  executor: Executor;
  config: PodStoreConfig;
  capability: ServiceDatabaseStoreCapability;
  bundle: EvidenceBundle;
  target?: DatabaseTarget;
  database?: Database;
  log: (line: string) => void;
}
