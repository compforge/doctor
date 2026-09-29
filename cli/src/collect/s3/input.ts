import { CommandInputError, type CommandInput } from "../../command";
import type { KubernetesCommandInput } from "../../command/kubernetes-target";

export const S3_ACTIONS = ["ls", "stat", "cat"] as const;
export type S3Action = typeof S3_ACTIONS[number];
export interface S3Input extends CommandInput, KubernetesCommandInput {
  action: S3Action;
  path?: string;
  service?: string;
  dataSource?: string;
  pod?: string;
  container?: string;
  recursive?: boolean;
  continuationToken?: string;
  versionId?: string;
  timeout?: string;
  maxItems?: string;
  maxBytes?: string;
}
export interface S3Request {
  action: S3Action;
  service?: string;
  bucket?: string;
  key: string;
  recursive: boolean;
  continuationToken?: string;
  versionId?: string;
  timeoutMs: number;
  maxItems: number;
  maxBytes: number;
}
function positive(value: string | undefined, fallback: number, name: string, maximum: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new CommandInputError(`${name} 必须为 1..${maximum} 的整数`);
  return n;
}

/** @spec Keys are literal: never normalize slashes, dot segments, percent escapes or whitespace. */
export function resolveS3Request(input: S3Input): S3Request {
  if (!S3_ACTIONS.includes(input.action)) throw new CommandInputError("S3 操作只支持 ls、stat、cat");
  let service = input.service?.trim() || undefined;
  let path = input.path ?? "";
  if (input.path === "") throw new CommandInputError("S3 路径不能为空");
  if (path.startsWith("s3://")) {
    path = path.slice(5);
    if (!path) throw new CommandInputError("s3:// 后需要 bucket");
  } else if (path.includes("://")) {
    throw new CommandInputError("使用 Service/bucket/key 或 s3://bucket/key；endpoint 来自 Service 配置");
  } else if (path && !service) {
    const slash = path.indexOf("/");
    service = slash < 0 ? path : path.slice(0, slash);
    path = slash < 0 ? "" : path.slice(slash + 1);
    if (!service) throw new CommandInputError("路径需要以 Service 名称开始");
  }
  const slash = path.indexOf("/");
  const bucket = (slash < 0 ? path : path.slice(0, slash)) || undefined;
  const key = slash < 0 ? "" : path.slice(slash + 1);
  if ((path && !bucket) || (bucket && /[\s?#\\]/.test(bucket))) throw new CommandInputError("无效的 bucket 路径");
  if (input.action !== "ls" && !bucket) throw new CommandInputError(`${input.action} 需要 bucket${input.action === "cat" ? "/key" : " 或 bucket/key"}`);
  if (input.action === "cat" && !key) throw new CommandInputError("cat 需要精确的对象 key");
  if (input.action !== "ls" && (input.recursive || input.continuationToken !== undefined)) throw new CommandInputError("--recursive / --continuation-token 仅用于 ls");
  if (input.action === "ls" && input.versionId !== undefined) throw new CommandInputError("--version-id 仅用于 stat/cat");
  if (input.versionId !== undefined && (!input.versionId || !key)) throw new CommandInputError("--version-id 需要非空版本和对象 key");
  if (input.continuationToken === "") throw new CommandInputError("--continuation-token 不能为空");
  if (input.recursive && !bucket) throw new CommandInputError("递归 ls 需要指定 bucket");
  return { action: input.action, service, bucket, key, recursive: !!input.recursive,
    continuationToken: input.continuationToken, versionId: input.versionId,
    timeoutMs: positive(input.timeout, 15, "--timeout", 300) * 1000,
    maxItems: positive(input.maxItems, 1000, "--max-items", 100_000),
    maxBytes: positive(input.maxBytes, 64 * 1024, "--max-bytes", 16 * 1024 * 1024),
  };
}
