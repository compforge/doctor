import type { ExecResult, ExecTarget, Executor } from "../../k8s/executor";

export interface NetworkCaptureMetadata {
  schema?: string;
  session_id: string;
  status: string;
  running?: boolean;
  pid?: number;
  started_at?: string;
  stopped_at?: string;
  stop_reason?: string;
  timeout_seconds?: number;
  max_bytes?: number;
  filter?: string;
  capture_file?: string;
  capture_bytes?: number;
  capture_sha256?: string;
  error?: string;
}

export interface NetworkCaptureResult {
  result: ExecResult;
  metadata?: NetworkCaptureMetadata;
  reason?: string;
}

export interface StartNetworkCaptureOptions {
  sessionId: string;
  timeoutSeconds: number;
  maxBytes: number;
  filter: string;
}

/** Generic capture control executed inside an already prepared debug environment. */
export interface NetworkCaptureRuntime {
  inspectReadiness(executor: Executor, target: ExecTarget): Promise<ExecResult>;
  start(
    executor: Executor,
    target: ExecTarget,
    options: StartNetworkCaptureOptions,
  ): Promise<NetworkCaptureResult>;
  status(executor: Executor, target: ExecTarget, sessionId: string): Promise<NetworkCaptureResult>;
  stop(executor: Executor, target: ExecTarget, sessionId: string): Promise<NetworkCaptureResult>;
  metadata(executor: Executor, target: ExecTarget, sessionId: string): Promise<NetworkCaptureResult>;
  cleanup(executor: Executor, target: ExecTarget, sessionId: string): Promise<NetworkCaptureResult>;
}
