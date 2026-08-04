import { createHash, createHmac } from "node:crypto";

export * from "./provider";

export interface S3Target {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  pathStyle: boolean;
}

export interface S3HeadBucketResult {
  ok: boolean;
  status: number;
}

export interface S3ObjectMetadata {
  key: string;
  size: number;
  lastModified: Date;
}

export interface S3ObjectPage {
  objects: S3ObjectMetadata[];
  commonPrefixes: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

export interface S3ListBucketsResult {
  buckets: string[];
}

interface QueryParameter {
  name: string;
  value: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function amzTimestamp(now: Date): { timestamp: string; date: string } {
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { timestamp, date: timestamp.slice(0, 8) };
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function canonicalQuery(parameters: readonly QueryParameter[]): string {
  return parameters
    .map(({ name, value }) => [awsEncode(name), awsEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function requestUrl(target: S3Target, bucketScoped: boolean): URL {
  const url = new URL(target.endpoint);
  if (!bucketScoped) return url;
  if (target.pathStyle) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${awsEncode(target.bucket)}`;
  } else {
    url.hostname = `${target.bucket}.${url.hostname}`;
    url.pathname = "/";
  }
  return url;
}

async function signedRequest(input: {
  target: S3Target;
  method: "GET" | "HEAD";
  query?: readonly QueryParameter[];
  timeoutMs: number;
  readBody?: boolean;
  bucketScoped?: boolean;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const url = requestUrl(input.target, input.bucketScoped ?? true);
  const query = canonicalQuery(input.query ?? []);
  url.search = query;
  const now = new Date();
  const { timestamp, date } = amzTimestamp(now);
  const payloadHash = sha256("");
  const canonicalHeaders = [
    `host:${url.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${timestamp}`,
    "",
  ].join("\n");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    input.method,
    url.pathname || "/",
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${input.target.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(`AWS4${input.target.secretKey}`, date);
  const regionKey = hmac(dateKey, input.target.region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(url, {
      method: input.method,
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=${input.target.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": timestamp,
      },
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      body: input.readBody ? await response.text() : "",
    };
  } finally {
    clearTimeout(timer);
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function xmlValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]!) : undefined;
}

export function parseListObjectsV2Xml(xml: string): S3ObjectPage {
  if (!/<ListBucketResult(?:\s|>)/.test(xml)) throw new Error("ListObjectsV2 返回了无效 XML");
  const objects: S3ObjectMetadata[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1]!;
    const key = xmlValue(block, "Key");
    const rawSize = xmlValue(block, "Size");
    const rawLastModified = xmlValue(block, "LastModified");
    const size = Number(rawSize);
    const lastModified = new Date(rawLastModified ?? "");
    if (key === undefined || !Number.isFinite(size) || size < 0 || Number.isNaN(lastModified.getTime())) {
      throw new Error("ListObjectsV2 Contents 缺少有效 Key/Size/LastModified");
    }
    objects.push({ key, size, lastModified });
  }
  const commonPrefixes = [...xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)]
    .flatMap((match) => {
      const prefix = xmlValue(match[1]!, "Prefix");
      return prefix === undefined ? [] : [prefix];
    });
  const isTruncated = xmlValue(xml, "IsTruncated") === "true";
  const nextContinuationToken = xmlValue(xml, "NextContinuationToken");
  if (isTruncated && !nextContinuationToken) {
    throw new Error("ListObjectsV2 响应已截断但缺少 NextContinuationToken");
  }
  return { objects, commonPrefixes, isTruncated, nextContinuationToken };
}

export function parseListBucketsXml(xml: string): S3ListBucketsResult {
  if (!/<ListAllMyBucketsResult(?:\s|>)/.test(xml)) throw new Error("ListBuckets 返回了无效 XML");
  const buckets = [...xml.matchAll(/<Bucket>([\s\S]*?)<\/Bucket>/g)].flatMap((match) => {
    const name = xmlValue(match[1]!, "Name");
    return name === undefined ? [] : [name];
  });
  return { buckets };
}

/** Minimal SigV4 HeadBucket client; Store diagnosis never reads or mutates object bodies. */
export async function headBucket(
  target: S3Target,
  timeoutMs = 10_000,
): Promise<S3HeadBucketResult> {
  const response = await signedRequest({ target, method: "HEAD", timeoutMs });
  return { ok: response.ok, status: response.status };
}

export async function listObjectsV2(
  target: S3Target,
  input: { prefix?: string; delimiter?: string; continuationToken?: string; maxKeys?: number; timeoutMs?: number } = {},
): Promise<S3ObjectPage> {
  const query: QueryParameter[] = [
    { name: "list-type", value: "2" },
    { name: "max-keys", value: String(input.maxKeys ?? 1000) },
  ];
  if (input.prefix) query.push({ name: "prefix", value: input.prefix });
  if (input.delimiter) query.push({ name: "delimiter", value: input.delimiter });
  if (input.continuationToken) {
    query.push({ name: "continuation-token", value: input.continuationToken });
  }
  const response = await signedRequest({
    target,
    method: "GET",
    query,
    timeoutMs: input.timeoutMs ?? 10_000,
    readBody: true,
  });
  if (!response.ok) throw new Error(`ListObjectsV2 返回 HTTP ${response.status}`);
  return parseListObjectsV2Xml(response.body);
}

export async function listBuckets(
  target: S3Target,
  timeoutMs = 10_000,
): Promise<S3ListBucketsResult> {
  const response = await signedRequest({
    target,
    method: "GET",
    timeoutMs,
    readBody: true,
    bucketScoped: false,
  });
  if (!response.ok) throw new Error(`ListBuckets 返回 HTTP ${response.status}`);
  return parseListBucketsXml(response.body);
}

export async function getBucketVersioning(
  target: S3Target,
  timeoutMs = 10_000,
): Promise<"enabled" | "suspended" | "disabled"> {
  const response = await signedRequest({
    target,
    method: "GET",
    query: [{ name: "versioning", value: "" }],
    timeoutMs,
    readBody: true,
  });
  if (!response.ok) throw new Error(`GetBucketVersioning 返回 HTTP ${response.status}`);
  const status = xmlValue(response.body, "Status");
  if (!status) return "disabled";
  if (status === "Enabled") return "enabled";
  if (status === "Suspended") return "suspended";
  throw new Error(`GetBucketVersioning 返回未知状态 '${status}'`);
}

export async function probeHttpStatus(
  endpoint: string,
  path: string,
  timeoutMs = 10_000,
): Promise<number | undefined> {
  const url = new URL(path, endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "HEAD", signal: controller.signal });
    return response.status;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
