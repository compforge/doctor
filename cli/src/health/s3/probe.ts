import { randomUUID, createHash } from "node:crypto";
import type { ConnectivityResult } from "@compforge/harness-toolbox/network";
import type { HttpResponse } from "@compforge/harness-toolbox/http";
import { approvalDeniedReason, type ApprovalGate } from "../../command/approval";
import { S3Error, type S3Client, type S3ErrorDetails } from "@compforge/harness-toolbox/s3";

import { captureS3HttpResponse, captureS3ErrorResponse, s3ResponseText, type S3HealthResponse } from "./response";

const CONTENT = Buffer.from("hello world", "utf8");
export interface S3HealthStep {
  operation: "upload" | "presign" | "download" | "cleanup";
  status: "passed" | "failed" | "not-run" | "cancelled";
  durationMs?: number;
  response?: S3HealthResponse;
  error?: string;
  expiresInSeconds?: number;
  bytes?: number;
  sha256?: string;
  failure?: S3ErrorDetails;
  reason?: string;
}
export interface S3HealthCheck {
  service: string;
  dataSource: string;
  executionLocation: "doctor-host";
  channel: "direct";
  endpoint?: string;
  downloadEndpoint?: string;
  connectivity?: { status: "passed" | "failed" | "unavailable"; evidence?: ConnectivityResult; reason?: string };
  region?: string;
  addressStyle?: "path" | "virtual-hosted";
  bucket?: string;
  key?: string;
  versionId?: string;
  startedAt: string;
  finishedAt?: string;
  status: "passed" | "failed" | "unavailable" | "cancelled" | "not-run";
  reason?: string;
  steps: S3HealthStep[];
}
export type S3ReadWriteClient = Pick<S3Client, "putObject" | "presignGetObject" | "deleteObject">;

/**
 * @spec Only a unique probe key is written and deleted; no bucket/object listing or customer-file reads.
 * @spec Download uses a short-lived presigned URL without credential headers; the URL is never retained in evidence.
 * @spec A confirmed upload is cleaned up even after cancellation or a failed download, using a separate deadline.
 */
export async function checkS3ReadWrite(input: {
  result: S3HealthCheck; bucket: string; prefix?: string; signal: AbortSignal; secrets?: readonly string[];
  approve: ApprovalGate; client: S3ReadWriteClient;
  download(url: string, signal: AbortSignal): Promise<HttpResponse>; checkpoint(): void;
}): Promise<void> {
  const { result, bucket, signal, client } = input;
  const prefix = input.prefix ? input.prefix.replace(/\/+$/, "") + "/" : "";
  const key = `${prefix}doctor-health/${randomUUID()}/hello.txt`;
  result.key = key;
  result.steps = ["upload", "presign", "download", "cleanup"].map(operation => ({ operation: operation as S3HealthStep["operation"], status: "not-run" }));
  const secrets = [...input.secrets ?? []];
  let uploaded = false;
  let uploadAttempted = false;
  let stage: S3HealthStep | undefined;
  let started = 0;
  try {
    signal.throwIfAborted();
    const decision = await input.approve({ id: "health-s3-read-write", risk: "disrupt", title: "S3 读写检查",
      target: `Doctor host → ${result.endpoint} · ${bucket}/${key}`,
      impact: ["上传 hello.txt（11 bytes，内容 hello world），通过预签名 URL 下载后校验内容，再删除本次测试对象。",
        "仅操作上述唯一 key；已启用版本控制时按上传返回的 versionId 清理。"],
    });
    if (!decision.approved) { result.status = "cancelled"; result.reason = approvalDeniedReason(decision.source); return; }
    signal.throwIfAborted();
    stage = result.steps[0]!; started = Date.now(); uploadAttempted = true;
    const upload = await client.putObject(bucket, key, CONTENT, { maxBytes: CONTENT.length, contentType: "text/plain", signal });
    result.versionId = upload.versionId; uploaded = true;
    stage.response = { httpStatus: upload.response?.httpStatusCode, requestId: upload.response?.requestId,
      extendedRequestId: upload.response?.extendedRequestId, attempts: upload.response?.attempts,
      etag: upload.etag, versionId: upload.versionId };
    Object.assign(stage, { status: "passed", durationMs: Date.now() - started, bytes: CONTENT.length });
    input.checkpoint();
    stage = result.steps[1]!; started = Date.now();
    signal.throwIfAborted();
    const url = await client.presignGetObject(bucket, key, { expiresIn: 60, versionId: result.versionId, signal });
    const signed = new URL(url);
    result.downloadEndpoint = signed.origin;
    secrets.push(url, ...["X-Amz-Signature", "X-Amz-Credential", "X-Amz-Security-Token"]
      .flatMap(key => signed.searchParams.get(key) ? [signed.searchParams.get(key)!] : []));
    Object.assign(stage, { status: "passed", durationMs: Date.now() - started, expiresInSeconds: 60 });
    input.checkpoint();
    stage = result.steps[2]!; started = Date.now();
    signal.throwIfAborted();
    const download = await input.download(url, signal);
    stage.response = captureS3HttpResponse(download, secrets);
    if (download.status !== 200) {
      // Classify from the protocol code; the response snapshot above owns bounded, sanitized detail.
      const code = Buffer.from(download.body).toString("utf8").match(/<Code>([A-Za-z0-9_.-]{1,200})<\/Code>/)?.[1];
      throw new S3Error({ code: code ?? "HttpError", httpStatus: download.status, requestId: download.headers["x-amz-request-id"] });
    }
    stage.bytes = download.body.length;
    stage.sha256 = createHash("sha256").update(download.body).digest("hex");
    stage.durationMs = Date.now() - started;
    stage.status = Buffer.from(download.body).equals(CONTENT) ? "passed" : "failed";
    if (stage.status === "failed") stage.reason = "下载内容与 hello world 不一致（预期 11 bytes，无换行）";
    result.status = stage.status;
    input.checkpoint();
  } catch (error) {
    result.status = signal.aborted ? "cancelled" : "failed";
    if (stage) {
      stage.response ??= captureS3ErrorResponse(error, secrets);
      if (error instanceof Error) stage.error = s3ResponseText(error.message, secrets).slice(0, 1024);
    }
    if (stage) Object.assign(stage, { status: signal.aborted ? "cancelled" : "failed",
      durationMs: Date.now() - started, failure: S3Error.from(error).toJSON(), reason: failureHint(error) });
    else result.reason = signal.aborted ? "执行前已取消" : S3Error.from(error).message;
  } finally {
    if (uploaded) {
      const cleanup = result.steps[3]!;
      const cleanupStarted = Date.now();
      try {
        // The caller keeps this client's lifetime independent of the command abort until finally completes.
        await client.deleteObject(bucket, key, { versionId: result.versionId, signal: AbortSignal.timeout(10_000) });
        cleanup.status = "passed";
      } catch (error) {
        cleanup.status = "failed";
        if (error instanceof Error) cleanup.error = s3ResponseText(error.message, secrets).slice(0, 1024);
        cleanup.response = captureS3ErrorResponse(error, secrets); cleanup.failure = S3Error.from(error).toJSON(); cleanup.reason = failureHint(error);
        if (result.status !== "cancelled") result.status = "failed";
        result.reason = "测试对象清理失败；请按报告中的 bucket、key 和 versionId 清理";
      }
      cleanup.durationMs = Date.now() - cleanupStarted;
    } else if (uploadAttempted) {
      result.steps[3]!.reason = "上传未确认成功，未执行删除；若请求在服务端成功而响应丢失，请按本次 key 检查残留";
    }
    result.finishedAt = new Date().toISOString();
    input.checkpoint();
  }
}

function failureHint(error: unknown): string {
  const { code, httpStatus } = S3Error.from(error);
  const hints: Record<string, string> = {
    AccessDenied: "核对当前操作的对象权限和 Bucket policy；PUT、GET、DELETE 权限分别检查。",
    NoSuchBucket: "核对服务配置的 Bucket 和 Endpoint。",
    NoSuchKey: "上传后未找到测试对象；核对存储的读后写行为与对象版本。",
    InvalidAccessKeyId: "服务端不识别 Access Key；核对服务配置的凭据与 Endpoint。",
    PermanentRedirect: "S3 要求其它 endpoint；结合响应中的 Location、Endpoint 和 bucket region 核对配置。",
    AuthorizationHeaderMalformed: "签名参数被服务端拒绝；结合响应中的 region 核对配置。",
    RequestExpired: "预签名请求已过期；核对 Doctor host 时钟和 URL 有效期。",
    InvalidToken: "临时凭据 token 无效；核对完整的临时凭据。",
    SignatureDoesNotMatch: "核对凭据、region、寻址方式及代理是否改写已签名请求。",
    RequestTimeTooSkewed: "核对 Doctor host 与 S3 服务端时钟。",
    ExpiredToken: "临时凭据过期；核对凭据刷新。",
    ENOTFOUND: "Doctor host 无法解析 S3 域名；检查主机 DNS 与 endpoint。",
    EAI_AGAIN: "Doctor host DNS 查询暂时失败。",
    ECONNREFUSED: "S3 连接被拒绝；核对 endpoint 端口、监听与网络访问。",
    ETIMEDOUT: "连接或请求超时；核对主机到 S3 的路由及访问策略。",
    CERT_HAS_EXPIRED: "S3 TLS 证书已过期。",
    DEPTH_ZERO_SELF_SIGNED_CERT: "Doctor host 不信任 S3 自签名证书；核对配置的 CA。",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "无法验证 S3 证书链；核对 CA 与服务端证书链。",
    ERR_TLS_CERT_ALTNAME_INVALID: "S3 endpoint 域名与证书不匹配。",
    AbortError: "请求已取消或达到 S3 请求期限。",
  };
  return hints[code] ?? (httpStatus === 403 ? hints.AccessDenied! : "查看该步骤的 S3 错误码、HTTP 状态和 RequestId；不从连接失败推断唯一原因。");
}
