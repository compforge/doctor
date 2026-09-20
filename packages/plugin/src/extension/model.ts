import type { Query } from "../capability";
import type { Extension, RegisteredExtension } from "./index";
import type { Model, ModelBackendHandle, ModelInferenceTarget, ModelType, TenantIdentity } from "../definition";
import type { ServiceEndpoint } from "../service";
import type { ServiceHttpResponse, HttpTransportResponse } from "../http";
import { requireExtensionEndpoint } from "./endpoint";

export const MODEL_QUERY_KIND = "model.query";
export const MODEL_BACKEND_INSPECT_KIND = "model.backend.inspect";
export const MODEL_BACKEND_VALIDATE_KIND = "model.backend.validate";
export const MODEL_INVOKE_KIND = "model.invoke";
export const MODEL_STREAM_KIND = "model.stream";

export type ModelBackendSummary = Pick<ModelBackendHandle, "modelId" | "modelName" | "model" | "type" | "provider">;
export interface ModelRequest {
  target: ModelInferenceTarget;
  timeoutMs: number;
  path: string;
  body: Record<string, unknown>;
}

export interface ModelQueryExtension extends Extension<Query<TenantIdentity, { type?: ModelType }>, Model[]> {
  readonly kind: typeof MODEL_QUERY_KIND;
  readonly endpoint: ServiceEndpoint;
}
export interface ModelBackendInspectExtension extends Extension<{ model: Model }, ModelBackendSummary | undefined> {
  readonly kind: typeof MODEL_BACKEND_INSPECT_KIND;
  readonly endpoint: ServiceEndpoint;
}
export interface ModelBackendValidateExtension extends Extension<{ model: Model; timeoutMs: number }, ServiceHttpResponse> {
  readonly kind: typeof MODEL_BACKEND_VALIDATE_KIND;
  readonly endpoint: ServiceEndpoint;
}
export interface ModelInvokeExtension extends Extension<ModelRequest, ServiceHttpResponse> {
  readonly kind: typeof MODEL_INVOKE_KIND;
  readonly endpoint: ServiceEndpoint;
}
/** The response body remains live after run resolves; callers own consumption or cancellation. */
export interface ModelStreamExtension extends Extension<ModelRequest & { signal: AbortSignal }, HttpTransportResponse> {
  readonly kind: typeof MODEL_STREAM_KIND;
  readonly endpoint: ServiceEndpoint;
}

function requireKind(extension: RegisteredExtension, kind: string): void {
  if (extension.kind !== kind) throw new Error(`Expected ${kind}, got ${extension.kind}`);
  requireExtensionEndpoint(extension);
}
export function requireModelQueryExtension(extension: RegisteredExtension): ModelQueryExtension {
  requireKind(extension, MODEL_QUERY_KIND); return extension as ModelQueryExtension;
}
export function requireModelBackendInspectExtension(extension: RegisteredExtension): ModelBackendInspectExtension {
  requireKind(extension, MODEL_BACKEND_INSPECT_KIND); return extension as ModelBackendInspectExtension;
}
export function requireModelBackendValidateExtension(extension: RegisteredExtension): ModelBackendValidateExtension {
  requireKind(extension, MODEL_BACKEND_VALIDATE_KIND); return extension as ModelBackendValidateExtension;
}
export function requireModelInvokeExtension(extension: RegisteredExtension): ModelInvokeExtension {
  requireKind(extension, MODEL_INVOKE_KIND); return extension as ModelInvokeExtension;
}
export function requireModelStreamExtension(extension: RegisteredExtension): ModelStreamExtension {
  requireKind(extension, MODEL_STREAM_KIND); return extension as ModelStreamExtension;
}

export function modelQueryOutput(value: unknown): Model[] {
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object"
    || [item.id, item.name, item.provider].some(field => typeof field !== "string")
    || !["llm", "embedding", "rerank", "audio"].includes(item.type))) {
    throw new Error("model.query returned an invalid model list");
  }
  return value;
}

/** Select public identity fields so private backend data and executable handles stay with the provider. */
export function modelBackendOutput(value: unknown): ModelBackendSummary | undefined {
  if (value === undefined) return undefined;
  const item = value as ModelBackendSummary;
  if (!item || [item.modelId, item.modelName, item.model, item.type, item.provider].some(field => typeof field !== "string")) {
    throw new Error("model.backend.inspect returned an invalid backend");
  }
  return { modelId: item.modelId, modelName: item.modelName, model: item.model, type: item.type, provider: item.provider };
}

function responseHead(value: unknown, kind: string): void {
  const item = value as HttpTransportResponse | undefined;
  if (!item || !Number.isInteger(item.statusCode) || item.statusCode < 100 || item.statusCode > 599
    || typeof item.statusText !== "string" || !item.headers || typeof item.headers !== "object"
    || Array.isArray(item.headers) || Object.values(item.headers).some(header => typeof header !== "string")) {
    throw new Error(`${kind} returned an invalid response`);
  }
}
export function modelResponseOutput(value: unknown): ServiceHttpResponse {
  responseHead(value, "model request");
  const item = value as ServiceHttpResponse;
  if (typeof item.ok !== "boolean" || typeof item.text !== "string" || !Number.isFinite(item.durationMs) || item.durationMs < 0) {
    throw new Error("model request returned an invalid response body or duration");
  }
  return item;
}
export function modelStreamOutput(value: unknown): HttpTransportResponse {
  responseHead(value, MODEL_STREAM_KIND);
  const item = value as HttpTransportResponse;
  if (item.body !== null && !(item.body instanceof ReadableStream)) throw new Error("model.stream returned an invalid body");
  return item;
}
