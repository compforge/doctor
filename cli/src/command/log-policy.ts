import type { PodLogCapturePolicy } from "@compforge/harness-toolbox/kubernetes/log-capture-plan";

/** Doctor owns customer-site defaults; the shared toolbox only enforces supplied limits. */
export const DEFAULT_POD_LOG_CAPTURE_POLICY: PodLogCapturePolicy = {
  concurrency: 4,
  maxBytesPerCapture: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};
