import type {
  Model,
  TenantConfigReader,
  TenantSummary,
} from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import type { EvidenceBundle } from "../evidence";
import type { Diagnosis, Evidence, Fact } from "../protocol";

export type TenantOutputFormat = "default" | "bundle" | "json" | "html";
export type TenantJsonValue = string | number | boolean | null
  | TenantJsonValue[]
  | { [key: string]: TenantJsonValue };

export interface CollectTenantCliOptions {
  namespace?: string;
  tenantId?: string;
  tenantName?: string;
  tenantConfigService?: string;
  modelCatalogService?: string;
  modelCatalogPort?: string;
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
  scopes: readonly string[];
  tenantConfigService?: string;
  format: TenantOutputFormat;
  reportName: string;
  profileName: string;
}

export interface TenantConfigurationTargetFact {
  service: string;
  endpoint: string;
  database: string;
  username: string;
  credentialSource: string;
}

export interface TenantConfigurationScopeFact {
  values: Record<string, TenantJsonValue>;
}

export type TenantConfigurationScopeFacts = Record<
  string,
  Fact<TenantConfigurationScopeFact>
>;

export interface TenantFacts {
  tenant: Fact<Pick<TenantSummary, "id" | "name" | "displayName">>;
  models: Fact<{ items: readonly Model[] }>;
  configurationTarget: Fact<TenantConfigurationTargetFact>;
  configuration: Fact<{
    scopes: Readonly<TenantConfigurationScopeFacts>;
  }>;
}

export type TenantEvidence = Evidence<never, TenantFacts>;
export type TenantFinding = never;
export type TenantDiagnosisGoal = "model-catalog" | "tenant-config";
export type TenantDiagnosis = Diagnosis<TenantEvidence, TenantFinding, TenantDiagnosisGoal>;

export interface TenantCommandContext {
  command: CommandContext;
  config: TenantConfig;
  bundle: EvidenceBundle;
  catalog: { listAvailable(tenantId: string): Promise<Model[]> };
  tenantConfigReader?: TenantConfigReader;
  prepareTenantConfigReader?: () => Promise<TenantConfigReader>;
}
