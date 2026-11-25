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

export async function inspectS3(client: S3Client, request: S3Request, prepare: (bucket: string, signal: AbortSignal) => Promise<S3Wire>,
  authorize: () => Promise<{ approved: true } | { approved: false; reason: string }>): Promise<S3Inspection> {
  const bucket = request.bucket!;
  const result: S3Inspection = { errors: {} };
  const started = performance.now();
  const signal = AbortSignal.any([client.signal, AbortSignal.timeout(request.timeoutMs)]);
  let wire: S3Wire | undefined;
  try {
    wire = await prepare(bucket, signal);
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
  if (!wire || signal.aborted) result.errors.chunk = signal.aborted ? "操作超时或已取消" : "S3 探测通道不可用";
  else {
    const remaining = Math.max(1, Math.ceil(request.timeoutMs - (performance.now() - started)));
    const permission = await authorize();
    if (!permission.approved) result.errors.chunk = permission.reason;
    else {
      result.chunk = await probeChunkLimit(wire, client, bucket, AbortSignal.any([client.signal, AbortSignal.timeout(remaining)]));
      if (result.chunk.stoppedReason !== "exact" && result.chunk.stoppedReason !== "budget") result.errors.chunk = result.chunk.stoppedReason;
    }
  }
  return result;
}
