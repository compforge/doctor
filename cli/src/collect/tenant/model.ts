import type {
  Model,
  ServiceInspectResult,
  TenantDirectory,
  TenantIdentity,
  TenantSummary,
} from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import type { EvidenceBundle } from "../evidence";
import type { Diagnosis, Evidence, Fact } from "../protocol";

export type TenantOutputFormat = "default" | "bundle" | "json" | "html";
export interface CollectTenantCliOptions {
  namespace?: string;
  tenantId?: string;
  tenantName?: string;
  tenantDirectoryService?: string;
  tenantDirectoryPort?: string;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  format?: string;
  output?: string;
}

export interface TenantConfig {
  tenant: TenantSummary;
  format: TenantOutputFormat;
  reportName: string;
  profileName: string;
}

export interface TenantCapabilityIdentity {
  id: string;
  service: string;
  capability: "modelCatalog" | "inspect";
}

export type TenantCapabilityResult =
  | { kind: "models"; models: readonly Model[] }
  | { kind: "data"; result: ServiceInspectResult };

export type TenantCapabilityFact = TenantCapabilityIdentity & Fact<TenantCapabilityResult>;
export type CollectedTenantCapabilityFact = TenantCapabilityIdentity
  & { status: "collected" }
  & TenantCapabilityResult;

export interface TenantFacts {
  tenant: Fact<Pick<TenantSummary, "id" | "name" | "displayName">>;
  capabilityFacts: readonly TenantCapabilityFact[];
}

export type TenantEvidence = Evidence<never, TenantFacts>;
export type TenantFinding = never;
export type TenantDiagnosisGoal = string;
export type TenantDiagnosis = Diagnosis<TenantEvidence, TenantFinding, TenantDiagnosisGoal>;

export interface TenantCapabilityCollector extends TenantCapabilityIdentity {
  id: string;
  query(identity: TenantIdentity): Promise<readonly TenantCapabilityResult[]>;
}

export interface TenantCommandContext {
  command: CommandContext;
  config: TenantConfig;
  bundle: EvidenceBundle;
  capabilities: readonly TenantCapabilityCollector[];
}

export interface TenantAccess {
  config: {
    profileName: string;
    kubernetes: {
      namespace: string;
      namespaceSource: string;
      kubeconfig?: string;
      context?: string;
    };
  };
  directory: TenantDirectory;
  capabilities: readonly TenantCapabilityCollector[];
  dispose(): Promise<void>;
}
