import type { SearchEngine } from "../../../infra/search";
import type { ExecTarget, Executor, KubectlOptions } from "../../../infra/k8s/executor";
import type { EvidenceBundle } from "../../evidence";
import type { OpenSearchAccessPreparation } from "../../shared/opensearch-access";
import type { OpenSearchVdbConnection, VdbConnection } from "./configuration";
import type { CommandContext } from "../../../command";
import type { VdbConfig } from "./config";

export interface VdbCommandContext {
  command: CommandContext;
  config: VdbConfig;
  executor: Executor;
  execTarget: ExecTarget;
  kube: KubectlOptions & { namespace: string };
  bundle: EvidenceBundle;
  connection?: VdbConnection;
  openSearchConnection?: OpenSearchVdbConnection;
  search?: SearchEngine;
  channel?: string;
  preparation?: OpenSearchAccessPreparation;
  log: (line: string) => void;
}
