import type { ServiceS3DataSource } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { S3Client, S3Target } from "@compforge/harness-toolbox/s3";
import type { S3BucketUsage } from "../../../infra/object-store";
import type { EvidenceBundle } from "../../evidence";
import type { StoreConfig } from "../config";
import type { CommandContext } from "../../../command";

export interface S3CommandContext {
  command: CommandContext;
  executor: Executor;
  config: StoreConfig;
  capability: ServiceS3DataSource;
  bundle: EvidenceBundle;
  originalEndpoint?: URL;
  preparedEndpoint?: string;
  target?: S3Target;
  inventoryPrefix?: string;
  serviceBucket?: string;
  servicePrefix?: string;
  accessibleBuckets?: string[];
  bucketUsage?: S3BucketUsage[];
  client?: S3Client;
  log: (line: string) => void;
}
