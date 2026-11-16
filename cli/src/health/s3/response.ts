import { S3Error } from "@compforge/harness-toolbox/s3";
import type { HttpResponse } from "@compforge/harness-toolbox/http";
import { diagnosticMessage } from "../../command/diagnostic";

export interface S3HealthResponse {
  httpStatus?: number;
  requestId?: string;
  extendedRequestId?: string;
  attempts?: number;
  etag?: string;
  versionId?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyTruncated?: boolean;
}

const HEADERS = new Set(["date", "server", "content-type", "content-length", "etag", "x-amz-version-id",
  "x-amz-request-id", "x-amz-id-2", "x-amz-bucket-region", "x-minio-deployment-id", "retry-after", "location"]);

/** @spec Preserve bounded S3 response facts while removing credentials and echoed signing material before truncation. */
export function s3ResponseText(value: string, secrets: readonly string[] = []): string {
  const text = value.replace(/<(AWSAccessKeyId|AccessKeyId|SecretAccessKey|SessionToken|Token|SignatureProvided|Signature|StringToSign|StringToSignBytes|CanonicalRequest|CanonicalRequestBytes|Authorization)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "<$1>[redacted]</$1>")
    .replace(/(X-Amz-(?:Signature|Credential|Security-Token)=)[^\s<>&"']+/gi, "$1[redacted]");
  return diagnosticMessage(text, secrets);
}

export function captureS3HttpResponse(response: HttpResponse, secrets: readonly string[]): S3HealthResponse {
  const body = Buffer.from(s3ResponseText(Buffer.from(response.body).toString("utf8"), secrets), "utf8");
  const headers = Object.fromEntries(Object.entries(response.headers).filter(([key]) => HEADERS.has(key.toLowerCase()))
    .map(([key, value]) => [key.toLowerCase(), s3ResponseText(value, secrets).slice(0, 1024)]));
  return { httpStatus: response.status, requestId: headers["x-amz-request-id"], extendedRequestId: headers["x-amz-id-2"],
    etag: headers.etag, versionId: headers["x-amz-version-id"], headers, body: body.subarray(0, 4096).toString("utf8"), bodyTruncated: body.length > 4096 };
}

/** SDK errors have already consumed the wire response; preserve parsed error details and response headers. */
export function captureS3ErrorResponse(error: unknown, secrets: readonly string[]): S3HealthResponse | undefined {
  const failure = S3Error.from(error);
  if (!failure.httpStatus) return undefined;
  const raw = failure.cause;
  const value = raw && typeof raw === "object" ? raw as { name?: string; message?: string; Region?: string; Endpoint?: string;
    $response?: { headers?: Record<string, string> } } : {};
  const body = [value.name, value.message, value.Region && `Region=${value.Region}`, value.Endpoint && `Endpoint=${value.Endpoint}`]
    .filter(Boolean).join("\n");
  const response = captureS3HttpResponse({ status: failure.httpStatus,
    headers: value.$response?.headers ?? {}, body: Buffer.from(body) }, secrets);
  return { ...response, requestId: failure.requestId ?? response.requestId,
    extendedRequestId: failure.extendedRequestId ?? response.extendedRequestId, attempts: failure.$metadata.attempts };
}
