import { randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { S3Error, type S3Client, type S3Target } from "@compforge/harness-toolbox/s3";
import type { HttpApi, HttpResponse } from "@compforge/harness-toolbox/http";
import { Sha256 } from "@smithy/core/checksum";
import { HttpRequest } from "@smithy/core/protocols";
import { SignatureV4 } from "@smithy/signature-v4";

const MiB = 1024 * 1024;
export const chunkBudget = { attempts: 16, bytes: 256 * MiB, largest: 64 * MiB };
type Objects = Pick<S3Client, "headObject" | "deleteObject">;

export class S3Wire {
  private readonly signer: SignatureV4;
  constructor(private readonly http: HttpApi, private readonly base: URL, target: S3Target) {
    this.signer = new SignatureV4({ credentials: target.credentials, region: target.region, service: "s3",
      sha256: Sha256, uriEscapePath: false });
  }
  async request(method: "HEAD" | "PUT", key: string, signal: AbortSignal, size?: number) {
    const path = this.base.pathname.replace(/\/$/, "") + (key ? "/" + key : "");
    const headers: Record<string, string> = { host: this.base.host };
    let body: Buffer | undefined;
    if (size !== undefined) {
      const header = Buffer.from(size.toString(16) + "\r\n");
      const data = Buffer.alloc(size);
      const checksum = Buffer.alloc(4);
      checksum.writeUInt32BE(crc32(data));
      const trailer = Buffer.from("\r\n0\r\nx-amz-checksum-crc32:" + checksum.toString("base64") + "\r\n\r\n");
      body = Buffer.concat([header, data, trailer]);
      Object.assign(headers, { "content-encoding": "aws-chunked", "content-length": String(body.length),
        "x-amz-content-sha256": "STREAMING-UNSIGNED-PAYLOAD-TRAILER", "x-amz-decoded-content-length": String(size),
        "x-amz-sdk-checksum-algorithm": "CRC32", "x-amz-trailer": "x-amz-checksum-crc32" });
    }
    const signed = await this.signer.sign(new HttpRequest({ method, protocol: this.base.protocol,
      hostname: this.base.hostname, port: this.base.port ? Number(this.base.port) : undefined, path: path || "/", headers, body }));
    const { host: _host, ...signedHeaders } = signed.headers;
    return this.http.request(path || "/", { method, headers: signedHeaders, body, signal });
  }
}

interface Sample {
  bytes: number;
  key: string;
  outcome: "accepted" | "size-rejected" | "unknown";
  httpStatus?: number;
  requestId?: string;
  error?: string;
  versionId?: string;
  cleanup?: string;
}
export interface ChunkProbe {
  samples: Sample[];
  acceptedBytes?: number;
  rejectedBytes?: number;
  maxChunkBytes?: number;
  stoppedReason: string;
}

/** A generic BadRequest, a proxy 413 or a timeout cannot establish an upper bound on an AWS data frame. */
function classify(response: HttpResponse, sample: Sample) {
  sample.httpStatus = response.status;
  sample.requestId = response.headers["x-amz-request-id"];
  if (response.status >= 200 && response.status < 300) return;
  const xml = Buffer.from(response.body).toString("utf8");
  const code = /<Code>([A-Za-z0-9_.-]{1,80})<\/Code>/.exec(xml)?.[1];
  sample.requestId ??= /<RequestId>([A-Za-z0-9+/_=-]{1,150})<\/RequestId>/i.exec(xml)?.[1];
  if (response.status === 400 && /<Message>[^<]*\bchunk too big\b/i.test(xml)) {
    sample.outcome = "size-rejected";
    sample.error = "chunk too big";
  } else sample.error = code ?? `HTTP ${response.status}`;
}

async function probeFrame(wire: Pick<S3Wire, "request">, client: Objects, bucket: string, size: number, signal: AbortSignal): Promise<Sample> {
  const key = "doctor-probe/" + randomUUID();
  const sample: Sample = { key, bytes: size, outcome: "unknown" };
  let cleanupNeeded = true;
  let versionChecked = false;
  try {
    const response = await wire.request("PUT", key, signal, size);
    classify(response, sample);
    if (response.status < 200 || response.status >= 300) {
      cleanupNeeded = response.status >= 500;
      return sample;
    }
    sample.versionId = response.headers["x-amz-version-id"];
    const object = await client.headObject(bucket, key, { versionId: sample.versionId, signal });
    sample.versionId ??= object.versionId;
    versionChecked = true;
    if (object.size === size) sample.outcome = "accepted";
    else sample.error = "stored length differs from decoded length";
  } catch (error) {
    sample.error = S3Error.from(error).code;
  } finally {
    if (cleanupNeeded) {
      const cleanupSignal = AbortSignal.timeout(5000);
      try {
        // If PUT lost its reply, recover its exact version before deleting in a versioned bucket.
        if (!versionChecked && !sample.versionId) {
          const object = await client.headObject(bucket, key, { signal: cleanupSignal });
          sample.versionId = object.versionId;
        }
        await client.deleteObject(bucket, key, { signal: cleanupSignal, versionId: sample.versionId });
        sample.cleanup = "deleted";
      } catch (error) { sample.cleanup = "unconfirmed: " + S3Error.from(error).code; }
    }
  }
  return sample;
}

/** @spec Only adjacent accepted and explicitly size-rejected wire frames establish an exact maximum. */
export async function probeChunkLimit(wire: Pick<S3Wire, "request">, client: Objects, bucket: string, signal: AbortSignal): Promise<ChunkProbe> {
  const result: ChunkProbe = { samples: [], stoppedReason: "budget" };
  let bytes = 0;
  const initial = 16 * MiB;
  let next = initial;
  while (next > 0 && next <= chunkBudget.largest && bytes + next <= chunkBudget.bytes && result.samples.length < chunkBudget.attempts) {
    if (signal.aborted) { result.stoppedReason = "deadline or cancellation"; break; }
    const sample = await probeFrame(wire, client, bucket, next, signal);
    result.samples.push(sample);
    bytes += next;
    if (sample.outcome === "accepted") result.acceptedBytes = next;
    if (sample.outcome === "size-rejected") result.rejectedBytes = next;
    if (sample.outcome === "unknown" || sample.cleanup?.startsWith("unconfirmed")) {
      result.stoppedReason = sample.cleanup?.startsWith("unconfirmed") ? sample.cleanup : sample.error ?? "unavailable";
      break;
    }
    const lo = result.acceptedBytes ?? 0;
    const hi = result.rejectedBytes;
    if (lo && hi === lo + 1) {
      result.maxChunkBytes = lo;
      result.stoppedReason = "exact";
      break;
    }
    if (hi !== undefined) {
      const middle = Math.floor((lo + hi) / 2);
      const wholeMiB = Math.floor(middle / MiB) * MiB;
      // Storage limits are commonly configured in MiB. Check the adjacent byte before refining.
      if (lo >= MiB && lo % MiB === 0) next = lo + 1;
      else next = wholeMiB > lo ? wholeMiB : middle;
    } else if (lo === initial) next = lo + 1;
    else next = Math.min(chunkBudget.largest + 1, 2 ** Math.ceil(Math.log2(lo + 1)));
  }
  return result;
}
