import { kubernetesNetworkCaptureRuntime } from "./k8s";

export type {
  NetworkCaptureMetadata,
  NetworkCaptureResult,
  NetworkCaptureRuntime,
  StartNetworkCaptureOptions,
} from "./model";

export const networkCaptureRuntime = kubernetesNetworkCaptureRuntime;
