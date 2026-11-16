export interface S3Failure {
  code: string;
  httpStatus?: number;
  requestId?: string;
  reason: string;
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
  const detail = httpStatus === 403 ? "当前 S3 操作被拒绝"
    : httpStatus === 404 ? "目标未找到；结合错误码核对 bucket、对象和版本"
    : "S3 请求未取得有效结果";
  return { code, httpStatus, requestId, reason: `${detail}（${code}${httpStatus ? `，HTTP ${httpStatus}` : ""}）` };
}

