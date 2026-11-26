import { S3Error, type S3Client, type S3ObjectMetadata } from "@compforge/harness-toolbox/s3";
import type { S3Request } from "./input";
import { probeChunkLimit, type ChunkProbe, type S3Wire } from "./chunk";

export interface S3Inspection {
  bucketHead?: { httpStatus: number; region?: string; server?: string; requestId?: string };
  versioning?: string;
  object?: S3ObjectMetadata;
  errors: Record<string, string>;
  chunk?: ChunkProbe;
}

export async function prepareInspection(bucket: string, timeoutMs: number, prepare: (bucket: string, signal: AbortSignal) => Promise<S3Wire>) {
  const deadline = performance.now() + timeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  const wire = await prepare(bucket, timeout).catch(error => S3Error.from(error));
  return { wire, deadline, timeout };
}

export async function inspectS3(client: S3Client, request: S3Request, runSignal: AbortSignal,
  inspection: Awaited<ReturnType<typeof prepareInspection>>,
  authorize: () => Promise<{ approved: true } | { approved: false; reason: string }>): Promise<S3Inspection> {
  const bucket = request.bucket!;
  const result: S3Inspection = { errors: {} };
  const { wire, deadline, timeout } = inspection;
  const signal = AbortSignal.any([runSignal, timeout]);
  if (wire instanceof S3Error) result.errors.headBucket = wire.message;
  else try {
    const response = await wire.request("HEAD", "", signal);
    result.bucketHead = { httpStatus: response.status, region: response.headers["x-amz-bucket-region"],
      server: response.headers.server, requestId: response.headers["x-amz-request-id"] };
    if (response.status < 200 || response.status >= 300) result.errors.headBucket = "HTTP " + response.status;
  } catch (error) { result.errors.headBucket = S3Error.from(error).message; }
  try { result.versioning = await client.getBucketVersioning(bucket, { signal }); }
  catch (error) { result.errors.versioning = S3Error.from(error).message; }
  if (request.key) {
    try { result.object = await client.headObject(bucket, request.key, { versionId: request.versionId, signal }); }
    catch (error) { result.errors.object = S3Error.from(error).message; }
  }
  if (signal.aborted) result.errors.chunk = "操作超时或已取消";
  else if (wire instanceof S3Error) result.errors.chunk = "S3 探测通道不可用";
  else {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    const permission = await authorize();
    if (!permission.approved) result.errors.chunk = permission.reason;
    else {
      result.chunk = await probeChunkLimit(wire, client, bucket, AbortSignal.any([runSignal, AbortSignal.timeout(remaining)]));
      if (result.chunk.stoppedReason !== "exact" && result.chunk.stoppedReason !== "budget") result.errors.chunk = result.chunk.stoppedReason;
    }
  }
  return result;
}
