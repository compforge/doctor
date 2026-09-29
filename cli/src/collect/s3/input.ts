import { CommandInputError, type CommandInput } from "../../command";
import { canPrompt, chooseParameter, inputParameter } from "../../terminal/parameters";
import type { KubernetesCommandInput } from "../../command/kubernetes-target";

export const S3_ACTIONS = ["ls", "stat", "cat"] as const;
export type S3Action = typeof S3_ACTIONS[number];
export interface S3Input extends CommandInput, KubernetesCommandInput {
  action?: S3Action;
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
function parseS3Input(input: S3Input) {
  if (input.action !== undefined && !S3_ACTIONS.includes(input.action)) throw new CommandInputError("S3 操作只支持 ls、stat、cat");
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
  if (input.action !== undefined && input.action !== "ls" && (input.recursive || input.continuationToken !== undefined)) throw new CommandInputError("--recursive / --continuation-token 仅用于 ls");
  if (input.action === "ls" && input.versionId !== undefined) throw new CommandInputError("--version-id 仅用于 stat/cat");
  if (input.versionId === "") throw new CommandInputError("--version-id 需要非空版本和对象 key");
  if (input.continuationToken === "") throw new CommandInputError("--continuation-token 不能为空");
  return { action: input.action, service, bucket, key, recursive: !!input.recursive,
    continuationToken: input.continuationToken, versionId: input.versionId,
    timeoutMs: positive(input.timeout, 15, "--timeout", 300) * 1000,
    maxItems: positive(input.maxItems, 1000, "--max-items", 100_000),
    maxBytes: positive(input.maxBytes, 64 * 1024, "--max-bytes", 16 * 1024 * 1024),
  };
}

function requireS3Target(request: S3Request): void {
  if (request.action !== "ls" && !request.bucket) throw new CommandInputError(`${request.action} 需要 bucket${request.action === "cat" ? "/key" : " 或 bucket/key"}`);
  if (request.action === "cat" && !request.key) throw new CommandInputError("cat 需要精确的对象 key");
  if (request.versionId !== undefined && !request.key) throw new CommandInputError("--version-id 需要非空版本和对象 key");
  if (request.recursive && !request.bucket) throw new CommandInputError("递归 ls 需要指定 bucket");
}

export function resolveS3Request(input: S3Input): S3Request {
  const parsed = parseS3Input(input);
  if (!parsed.action) throw new CommandInputError("缺少 S3 操作：请指定 ls / stat / cat");
  const request = { ...parsed, action: parsed.action };
  requireS3Target(request);
  return request;
}

/** Validate explicit values before discovery; only absent inputs may be completed interactively. */
export function validateS3Input(input: S3Input): void {
  const parsed = parseS3Input(input);
  if (!canPrompt({ interactive: input.interactive })) { resolveS3Request(input); return; }
  if (parsed.action && input.path !== undefined) requireS3Target({ ...parsed, action: parsed.action });
}

export async function promptS3Request(input: S3Input): Promise<S3Request> {
  validateS3Input(input);
  const interactive = canPrompt({ interactive: input.interactive });
  let action = input.action;
  let path = input.path;
  let browsePath = false;
  if (!action) {
    const options = {
      "列出 bucket（ls）": "ls", "浏览 bucket / 目录（ls）": "ls",
      "查看 bucket / 对象元数据（stat）": "stat", "读取对象内容（cat）": "cat",
    } as const;
    const choice = await chooseParameter("S3 操作", Object.keys(options), interactive);
    action = options[choice as keyof typeof options];
    browsePath = choice === "浏览 bucket / 目录（ls）";
  }
  if (path === undefined && (browsePath || action !== "ls" || input.recursive || input.versionId !== undefined)) {
    path = await inputParameter(input.service ? "目标路径（bucket/key 或 s3://bucket/key）" : "目标路径（Service/bucket/key 或 s3://bucket/key）", interactive);
  }
  return resolveS3Request({ ...input, action, path });
}
