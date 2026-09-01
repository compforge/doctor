import type { Fact } from "../../../protocol";

export interface VdbExecutionFact {
  namespace: string;
  pod?: string;
  container?: string;
}

export interface VdbConfigurationFact {
  type: "opensearch" | "unsupported";
  backend: string;
  store: string;
  configSource: "kubernetes-config" | "container-runtime" | "plugin";
  configurationKind: string;
  configPath?: string;
  endpoint?: string;
  username?: string;
  credentials?: "configured" | "anonymous-or-incomplete";
}

export interface VdbAccessFact {
  backend: "opensearch";
  channel: string;
  endpoint?: string;
  service?: string;
}

export interface VdbInspectionFacts {
  execution: Fact<VdbExecutionFact, "store.vdb.execution">;
  configuration: Fact<VdbConfigurationFact, "store.vdb.configuration">;
  access: Fact<VdbAccessFact, "store.vdb.access">;
}
