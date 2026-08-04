import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { HttpRequestGroup, HttpRequestPlan, HttpScenario } from "./model";

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_RESPONSE_MIB = 32;
const DEFAULT_SUCCESS_STATUSES = Array.from({ length: 100 }, (_, index) => 200 + index);

const headersSchema = z.record(z.string(), z.string()).default({});
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "只能包含字母、数字、点、下划线和短横线");
const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "只支持 http:// 或 https://");
const expectationSchema = z.object({
  status: z.union([
    z.number().int().min(100).max(599).transform((value) => [value]),
    z.array(z.number().int().min(100).max(599)).min(1),
  ]).optional(),
  content_type: z.string().min(1).optional(),
  max_duration_ms: z.number().positive().optional(),
  sse_terminal_event: z.string().min(1).optional(),
}).strict().default({});

const entrypointSchema = z.object({
  id: idSchema,
  url: httpUrlSchema.optional(),
  headers: headersSchema.optional(),
  follow_redirects: z.boolean().optional(),
}).strict();

const requestSchema = z.object({
  id: idSchema,
  url: httpUrlSchema,
  entrypoints: z.array(entrypointSchema).min(1).optional(),
  method: z.string().min(1).default("GET"),
  headers: headersSchema.optional(),
  json: z.unknown().optional(),
  body: z.string().optional(),
  body_file: z.string().min(1).optional(),
  timeout_seconds: z.number().positive().optional(),
  max_response_mib: z.number().positive().optional(),
  follow_redirects: z.boolean().optional(),
  expect: expectationSchema.optional(),
  compare: z.object({
    body: z.enum(["none", "exact"]).default("none"),
    sse_events: z.boolean().default(true),
  }).strict().default({ body: "none", sse_events: true }),
}).strict().superRefine((request, context) => {
  const bodyFields = [request.json !== undefined, request.body !== undefined, request.body_file !== undefined]
    .filter(Boolean).length;
  if (bodyFields > 1) {
    context.addIssue({ code: "custom", message: "json、body、body_file 只能设置一个" });
  }
  const entrypointIds = new Set<string>();
  request.entrypoints?.forEach((entrypoint, index) => {
    if (entrypointIds.has(entrypoint.id)) {
      context.addIssue({ code: "custom", path: ["entrypoints", index, "id"], message: `重复的 entrypoint id '${entrypoint.id}'` });
    }
    entrypointIds.add(entrypoint.id);
  });
  if (request.entrypoints?.length === 1) {
    context.addIssue({ code: "custom", path: ["entrypoints"], message: "只有一个入口时直接使用 url；entrypoints 用于对比两个或更多入口" });
  }
  if (["GET", "HEAD"].includes(request.method.toUpperCase()) && bodyFields > 0) {
    context.addIssue({ code: "custom", message: `${request.method.toUpperCase()} 请求不能携带 body` });
  }
});

const scenarioSchema = z.object({
  schema: z.literal("doctor-http/v1"),
  name: z.string().min(1).optional(),
  headers: headersSchema.optional(),
  timeout_seconds: z.number().positive().optional(),
  max_response_mib: z.number().positive().optional(),
  follow_redirects: z.boolean().optional(),
  requests: z.array(requestSchema).min(1),
}).strict().superRefine((scenario, context) => {
  const seen = new Set<string>();
  scenario.requests.forEach((request, index) => {
    if (seen.has(request.id)) {
      context.addIssue({ code: "custom", path: ["requests", index, "id"], message: `重复的 request id '${request.id}'` });
    }
    seen.add(request.id);
  });
});

export interface HttpScenarioOverrides {
  timeoutSeconds?: number;
  maxResponseMiB?: number;
}

function encodeBody(
  request: z.infer<typeof requestSchema>,
  scenarioPath: string,
  headers: Record<string, string>,
): Uint8Array | undefined {
  if (request.json !== undefined) {
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    return new TextEncoder().encode(JSON.stringify(request.json));
  }
  if (request.body !== undefined) return new TextEncoder().encode(request.body);
  if (request.body_file !== undefined) {
    const path = resolve(dirname(scenarioPath), request.body_file);
    try {
      return readFileSync(path);
    } catch (error) {
      throw new Error(`读取 request '${request.id}' 的 body_file '${request.body_file}' 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return undefined;
}

export function loadHttpScenario(path: string, overrides: HttpScenarioOverrides = {}): HttpScenario {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    throw new Error(`读取 HTTP 请求文件 '${path}' 失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: z.infer<typeof scenarioSchema>;
  try {
    parsed = scenarioSchema.parse(parseYaml(raw));
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
      throw new Error(`HTTP 请求文件格式错误: ${details}`);
    }
    throw new Error(`HTTP 请求文件解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  const requests: HttpRequestGroup[] = parsed.requests.map((request) => {
    const commonHeaders = { ...(parsed.headers ?? {}), ...(request.headers ?? {}) };
    const body = encodeBody(request, path, commonHeaders);
    const entrypoints = request.entrypoints ?? [{ id: "default", headers: {}, follow_redirects: undefined }];
    const plans: HttpRequestPlan[] = entrypoints.map((entrypoint) => ({
      requestId: request.id,
      entrypointId: entrypoint.id,
      method: request.method.toUpperCase(),
      url: entrypoint.url ?? request.url,
      headers: { ...commonHeaders, ...(entrypoint.headers ?? {}) },
      body,
      followRedirects: entrypoint.follow_redirects ?? request.follow_redirects ?? parsed.follow_redirects ?? true,
      timeoutMs: 1000 * (overrides.timeoutSeconds ?? request.timeout_seconds ?? parsed.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS),
      maxResponseBytes: 1024 * 1024 * (overrides.maxResponseMiB ?? request.max_response_mib ?? parsed.max_response_mib ?? DEFAULT_MAX_RESPONSE_MIB),
      expect: {
        status: request.expect?.status ?? DEFAULT_SUCCESS_STATUSES,
        contentType: request.expect?.content_type,
        maxDurationMs: request.expect?.max_duration_ms,
        sseTerminalEvent: request.expect?.sse_terminal_event,
      },
    }));
    return {
      id: request.id,
      entrypoints: plans,
      compare: { body: request.compare.body, sseEvents: request.compare.sse_events },
    };
  });
  return {
    schema: parsed.schema,
    name: parsed.name ?? basename(path),
    requests,
  };
}

export const HTTP_DEFAULTS = {
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  maxResponseMiB: DEFAULT_MAX_RESPONSE_MIB,
} as const;
