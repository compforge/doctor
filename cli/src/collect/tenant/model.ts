import type {
  TenantContributionSnapshot,
  TenantDirectory,
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

export interface TenantContributionIdentity {
  id: string;
  title: string;
  service: string;
}

export type TenantContributionFact = TenantContributionIdentity & Fact<TenantContributionSnapshot>;
export type CollectedTenantContributionFact = TenantContributionIdentity
  & { status: "collected" }
  & TenantContributionSnapshot;

export interface TenantFacts {
  tenant: Fact<Pick<TenantSummary, "id" | "name" | "displayName">>;
  contributions: Readonly<Record<string, TenantContributionFact>>;
}

export type TenantEvidence = Evidence<never, TenantFacts>;
export type TenantFinding = never;
export type TenantDiagnosisGoal = string;
export type TenantDiagnosis = Diagnosis<TenantEvidence, TenantFinding, TenantDiagnosisGoal>;

export interface TenantContributionCollector {
  id: string;
  title: string;
  service: string;
  collect(tenantId: string): Promise<TenantContributionSnapshot>;
}

export interface TenantCommandContext {
  command: CommandContext;
  config: TenantConfig;
  bundle: EvidenceBundle;
  contributions: readonly TenantContributionCollector[];
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
  contributions: readonly TenantContributionCollector[];
  dispose(): Promise<void>;
}
