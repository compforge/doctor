import type { HttpCapture, SendHttp } from "../shared/http/capture";
import type { HttpRequestPlan } from "../shared/http/model";
import type {
  NetworkCaptureMetadata,
  NetworkCaptureRuntime,
} from "../../infra/target/network-capture";
import type { ExecTarget, Executor } from "../../infra/k8s/executor";
import type {
  DownloadFromTargetOptions,
  DownloadFromTargetResult,
} from "../../infra/file-transfer";
import type { TerminalProgressUpdate } from "../../terminal/progress";

export type NetworkCaptureMode = "tracking" | "watch";

export interface CollectNetworkCliOpts {
  file?: string;
  namespace?: string;
  services?: string;
  timeout: string;
  drain: string;
  maxPcapSize: string;
  maxResponseSize: string;
  filter?: string;
  cleanupRemote?: boolean;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  output?: string;
}

export interface NetworkPodTarget {
  pod: string;
  podIp?: string;
  services: string[];
  debug: ExecTarget;
  debugImage: string;
}

export interface MissingNetworkTarget {
  service?: string;
  pod?: string;
  reason: string;
  required: boolean;
}

export interface NetworkTopology {
  services: Array<{
    name: string;
    clusterIp?: string;
    ports: number[];
    pods: string[];
    optional: boolean;
  }>;
  targets: NetworkPodTarget[];
  missing: MissingNetworkTarget[];
  filter: string;
}

export interface NetworkCaptureArtifact {
  pod: string;
  services: string[];
  debugContainer: string;
  file?: string;
  bytes?: number;
  sha256?: string;
  verified: boolean;
  windowComplete: boolean;
  reason?: string;
  metadata?: NetworkCaptureMetadata;
}

export interface CollectNetworkOptions {
  namespace: string;
  services: string[];
  capturePlan:
    | {
        mode: Extract<NetworkCaptureMode, "tracking">;
        requestFile: string;
        requestSource: string;
        request: HttpRequestPlan;
      }
    | {
        mode: Extract<NetworkCaptureMode, "watch">;
      };
  timeoutSeconds: number;
  drainSeconds: number;
  maxPcapBytes: number;
  maxResponseBytes: number;
  filter?: string;
  cleanupRemote: boolean;
  outputDir: string;
  sessionId: string;
  captureId: string;
  signal?: AbortSignal;
}

export interface NetworkCollectDependencies {
  executor: Executor;
  captureRuntime: NetworkCaptureRuntime;
  downloadFromTarget(options: DownloadFromTargetOptions): Promise<DownloadFromTargetResult>;
  sendHttp?: SendHttp;
  sleep(ms: number): Promise<void>;
  log?(line: string): void;
  progress?(update: TerminalProgressUpdate): void;
  waitForWatchCompletion?(input: {
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<"completed" | "cancelled" | "timeout">;
}

export interface NetworkCollectResult {
  code: number;
  captureMode: NetworkCaptureMode;
  topology?: NetworkTopology;
  artifacts: NetworkCaptureArtifact[];
  traceIds: string[];
  response?: HttpCapture;
  reason?: string;
}
