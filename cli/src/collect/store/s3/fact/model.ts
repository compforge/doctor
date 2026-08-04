import type { Fact } from "../../../protocol";

export interface S3ConfigurationFact {
  backend: string;
  endpoint: string;
  bucket: string;
  bucketPrefix?: string;
  region: string;
  addressStyle: "path" | "virtual";
  credentials: "configured";
  source: string;
}
export interface S3AccessFact {
  channel: "direct" | "service-port-forward";
  endpoint: string;
}
export interface S3ProviderFact {
  providerId: string;
  displayName: string;
  detection: string;
  capabilities: {
    health: boolean;
    bucketUsage: boolean;
    physicalCapacity: boolean;
  };
}
export interface S3InspectionFacts {
  configuration: Fact<S3ConfigurationFact>;
  access: Fact<S3AccessFact>;
  provider: Fact<S3ProviderFact>;
}
