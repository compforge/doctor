import type { S3Client, S3ObjectMetadata } from "@compforge/harness-toolbox/s3";
import type { S3Request } from "./input";

export interface S3Entry {
  type: "bucket" | "prefix" | "object";
  name: string;
  size?: number;
  modified?: Date;
}
export interface S3Failure {
  code: string;
  httpStatus?: number;
  requestId?: string;
  reason: string;
}
export interface S3Result {
  entries: S3Entry[];
  pages: number;
  complete: boolean;
  continuationToken?: string;
  stoppedReason?: string;
  metadata?: S3ObjectMetadata;
  bytes?: Uint8Array;
  failure?: S3Failure;
}

/** SDK messages can contain signed URLs. Retain protocol fields without echoing the raw message. */
export function s3Failure(error: unknown): S3Failure {
  const value = error && typeof error === "object" ? error as {
    name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: number; requestId?: string };
  } : {};
  const identifier = (candidate: unknown) => typeof candidate === "string" && /^[a-zA-Z0-9_.:/+=-]{1,200}$/.test(candidate) ? candidate : undefined;
  const code = identifier(value.code) ?? identifier(value.name) ?? "S3Error";
  const httpStatus = value.$metadata?.httpStatusCode;
  const requestId = identifier(value.$metadata?.requestId);
  const detail = httpStatus === 403 ? "访问被拒绝，无法判断对象是否存在"
    : httpStatus === 404 ? "目标未找到；HEAD 响应不足以区分 bucket、对象或版本缺失"
    : "S3 请求未取得有效结果";
  return { code, httpStatus, requestId, reason: `${detail}（${code}${httpStatus ? `，HTTP ${httpStatus}` : ""}）` };
}

type S3Access = Pick<S3Client, "signal" | "listBuckets" | "listObjects" | "headBucket" | "headObject" | "readObject">;

/** @spec Traversal is bounded and explicit; partial or failed listings never become an empty directory. */
export async function executeS3(client: S3Access, request: S3Request): Promise<S3Result> {
  const result: S3Result = { entries: [], pages: 0, complete: false };
  const deadline = AbortSignal.timeout(request.timeoutMs);
  const signal = AbortSignal.any([client.signal, deadline]);
  try {
    if (request.action === "stat") {
      if (request.key) result.metadata = await client.headObject(request.bucket!, request.key, { signal, versionId: request.versionId });
      else await client.headBucket(request.bucket!, { signal });
      result.complete = true;
      return result;
    }
    if (request.action === "cat") {
      const { bytes, truncated, ...metadata } = await client.readObject(request.bucket!, request.key, {
        signal, versionId: request.versionId, maxBytes: request.maxBytes,
      });
      result.bytes = bytes; result.metadata = metadata; result.complete = !truncated;
      if (truncated) result.stoppedReason = "byte-limit";
      return result;
    }
    let token = request.continuationToken;
    const tokens = new Set<string>();
    while (result.entries.length < request.maxItems) {
      signal.throwIfAborted();
      if (token) tokens.add(token);
      const remaining = Math.min(1000, request.maxItems - result.entries.length);
      let entries: S3Entry[];
      let next: string | undefined;
      if (!request.bucket) {
        const page = await client.listBuckets({ maxBuckets: remaining, continuationToken: token, signal });
        entries = page.buckets.map(bucket => ({ type: "bucket", name: bucket.name, modified: bucket.creationDate }));
        next = page.continuationToken;
      } else {
        const page = await client.listObjects(request.bucket, { prefix: request.key,
          delimiter: request.recursive ? undefined : "/", maxKeys: remaining, continuationToken: token, signal });
        entries = [
          ...page.prefixes.map(name => ({ type: "prefix" as const, name })),
          ...page.objects.map(object => ({ type: "object" as const, name: object.key, size: object.size, modified: object.lastModified })),
        ].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        if (page.truncated && !page.continuationToken) throw Object.assign(new Error(), { code: "MissingContinuationToken" });
        next = page.truncated ? page.continuationToken : undefined;
      }
      // A token resumes after the full page. Never discard entries and return a token that skips them.
      if (entries.length > remaining) throw Object.assign(new Error(), { code: "ListingExceededPageLimit" });
      result.entries.push(...entries); result.pages++;
      result.continuationToken = next;
      if (!next) { result.complete = true; return result; }
      if (tokens.has(next)) throw Object.assign(new Error(), { code: "RepeatedContinuationToken" });
      token = next;
    }
    result.stoppedReason = "item-limit";
  } catch (error) {
    client.signal.throwIfAborted();
    if (deadline.aborted) result.stoppedReason = "time-limit";
    else result.failure = s3Failure(error);
  }
  return result;
}
