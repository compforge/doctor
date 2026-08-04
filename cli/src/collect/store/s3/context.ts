import type { ServiceS3StoreCapability } from "@compforge/doctor-plugin";
import type { Executor } from "../../../infra/k8s/executor";
import type { ServicePortForwarder } from "../../../infra/k8s/service-port-forward";
import type { S3BucketUsage, S3Target } from "../../../infra/object-store";
import type { EvidenceBundle } from "../../evidence";
import type { StoreConfig } from "../config";

export interface S3CollectContext {
  executor: Executor;
  config: StoreConfig;
  capability: ServiceS3StoreCapability;
  bundle: EvidenceBundle;
  originalEndpoint?: URL;
  preparedEndpoint?: string;
  target?: S3Target;
  inventoryPrefix?: string;
  serviceBucket?: string;
  servicePrefix?: string;
  accessibleBuckets?: string[];
  bucketUsage?: S3BucketUsage[];
  forwarder?: ServicePortForwarder;
  log: (line: string) => void;
}
