import type { ExecResult, ExecTarget, Executor } from "../k8s/executor";

export interface DownloadFromTargetOptions {
  executor: Executor;
  target: ExecTarget;
  targetPath: string;
  hostPath: string;
  expectedBytes: number;
  chunkBytes?: number;
  onStart?: (totalSlices: number) => void;
  onProgress?: (progress: {
    slice: number;
    totalSlices: number;
    fetchedBytes: number;
    totalBytes: number;
  }) => void;
  onRetry?: (offset: number, attempt: number, reason: string) => void;
}

export interface DownloadFromTargetResult {
  ok: boolean;
  bytesWritten: number;
  slices: number;
  retries: number;
  failure?: {
    offset: number;
    expectedBytes: number;
    receivedBytes: number;
    result: ExecResult;
  };
}

export interface UploadToTargetOptions {
  executor: Executor;
  target: ExecTarget;
  hostPath: string;
  targetPath: string;
  maxBytes?: number;
}

/** Bidirectional file transfer between the Doctor Host and a diagnostic Target. */
export interface HostTargetFileTransfer {
  downloadFromTarget(options: DownloadFromTargetOptions): Promise<DownloadFromTargetResult>;
  uploadToTarget(options: UploadToTargetOptions): Promise<ExecResult>;
}
