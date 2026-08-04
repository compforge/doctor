import type { ServiceDatabaseStoreCapability } from "@compforge/doctor-plugin";
import type { DatabaseTarget } from "../../../infra/database";
import type { MysqlDatabase } from "../../../infra/database/mysql";
import type { Executor } from "../../../infra/k8s/executor";
import type { ServicePortForwarder } from "../../../infra/k8s/service-port-forward";
import type { EvidenceBundle } from "../../evidence";
import type { StoreConfig } from "../config";

export interface DbCollectContext {
  executor: Executor;
  config: StoreConfig;
  capability: ServiceDatabaseStoreCapability;
  bundle: EvidenceBundle;
  target?: DatabaseTarget;
  database?: MysqlDatabase;
  forwarder?: ServicePortForwarder;
  log: (line: string) => void;
}
