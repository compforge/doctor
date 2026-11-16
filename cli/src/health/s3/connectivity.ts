import { probeConnectivity, type ConnectivityExecutor } from "@compforge/harness-toolbox/network";
import { endpointFromUrl } from "@compforge/harness-toolbox/endpoint";
import { runArgv } from "@compforge/harness-toolbox/kubernetes/executor";
import type { S3Target } from "@compforge/harness-toolbox/s3";
import { diagnosticMessage } from "../../command/diagnostic";
import type { S3HealthCheck } from "./probe";

const NETWORK_ERRORS = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE",
  "ENETUNREACH", "EHOSTUNREACH", "TimeoutError", "AbortError", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"]);
const executeHost: ConnectivityExecutor = async (argv, options) => {
  const result = await runArgv([...argv], options);
  if (!result.ok) throw new Error(result.timedOut ? "Host connectivity probe timed out" : "Host python3 connectivity probe unavailable");
  return result.stdout;
};

/** Supplemental network observations never replace the actual S3 operation failure. */
export async function supplementS3Connectivity(check: S3HealthCheck, target: S3Target, signal: AbortSignal,
  execute: ConnectivityExecutor = executeHost): Promise<void> {
  if (signal.aborted || !check.steps.some(step => step.failure && !step.failure.httpStatus && NETWORK_ERRORS.has(step.failure.code))) return;
  const endpoint = endpointFromUrl(check.downloadEndpoint ?? target.endpoint);
  // Generic connectivity uses system CA; do not report a false TLS failure against a custom-CA S3 target.
  const probe = target.ca ? { host: endpoint.host, port: endpoint.port } : endpoint;
  const reason = target.ca ? "配置了自定义 CA，补充探测仅检查 DNS/TCP；TLS 以实际 S3 请求为准" : "Doctor host python3 使用系统 CA 的补充探测";
  try {
    const evidence = await probeConnectivity(probe, execute, { timeoutMs: 5000, signal });
    check.connectivity = { status: evidence.status, evidence, reason };
  } catch (error) { check.connectivity = { status: "unavailable", reason: diagnosticMessage(error) }; }
}
