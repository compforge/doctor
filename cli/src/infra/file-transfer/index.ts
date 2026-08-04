import { kubernetesHostTargetFileTransfer } from "./k8s";
import type { HostTargetFileTransfer } from "./model";

export type {
  DownloadFromTargetOptions,
  DownloadFromTargetResult,
  HostTargetFileTransfer,
  UploadToTargetOptions,
} from "./model";

export const hostTargetFileTransfer: HostTargetFileTransfer = kubernetesHostTargetFileTransfer;
