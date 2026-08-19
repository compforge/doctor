import type { ServiceDatabaseStoreCapability } from "@compforge/doctor-plugin";
import type { DatabaseTarget } from "../../../infra/database";
import type { MysqlDatabase } from "../../../infra/database/mysql";
import type { Executor } from "../../../infra/k8s/executor";
import type { ServicePortForwarder } from "../../../infra/k8s/service-port-forward";
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
  database?: MysqlDatabase;
  forwarder?: ServicePortForwarder;
  log: (line: string) => void;
}
