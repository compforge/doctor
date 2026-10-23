import { ToolboxError, type ErrorKind } from "@compforge/harness-toolbox/errors";
import { validateResourceSnapshot, type Resource, type ResourceSnapshot, type JsonObject, type ResourceQuery,
  type OperationResult, type Summary } from "@compforge/doctor-plugin";
import { CommandStatus } from "../command";
import type { ResourceProvider } from "./catalog";

export interface ResourceEntry {
  service: string;
  resource: Resource;
  relationship: "manages" | "uses";
  snapshot?: ResourceSnapshot<JsonObject>;
  summary?: Summary;
  issue?: { kind: ErrorKind; code?: string | number; message: string };
}
export interface ResourceResult { mode: "catalog" | "snapshot"; entries: ResourceEntry[] }
export function resourceDeclaration(provider: ResourceProvider): ResourceEntry {
  const { id, kind, name, description } = provider.binding.resource;
  return { service: provider.service.name, resource: { id, kind, name, description }, relationship: provider.binding.relationship };
}

/**
 * @spec Each provider retains its outcome; permission_denied is expected missing evidence, not a health verdict.
 * @spec Cancellation stops scheduling and preserves completed observations. No implicit pagination or total inference.
 * @link cli/docs/commands/resource.md
 */
export async function collectResources(providers: readonly ResourceProvider[], query: ResourceQuery, actions: {
  signal: AbortSignal;
  observe(provider: ResourceProvider, query: ResourceQuery): Promise<{ environment: string; result: OperationResult<ResourceSnapshot<JsonObject>> }>;
  progress?(entry: ResourceEntry, phase: "start" | "finish"): void;
}): Promise<{ status: CommandStatus; output: ResourceResult }> {
  const entries: ResourceEntry[] = [];
  for (const provider of providers) {
    if (actions.signal.aborted) break;
    const entry = resourceDeclaration(provider);
    actions.progress?.(entry, "start");
    let validating = false;
    try {
      const { result, environment } = await actions.observe(provider, query);
      validating = true;
      validateResourceSnapshot(result.data, { resource: entry.resource, environment }, query);
      // Freeze the evidence before starting another provider; never serialize live Plugin objects.
      entry.snapshot = JSON.parse(JSON.stringify(result.data));
      entry.summary = JSON.parse(JSON.stringify(result.summary));
    } catch (error) {
      if (actions.signal.aborted) break;
      const kind = error instanceof ToolboxError ? error.kind : validating ? "invalid_response" : "operation_failed";
      entry.issue = { kind, code: error instanceof ToolboxError ? error.code : undefined,
        message: kind === "permission_denied" ? "无权限" : `资源采集失败：${kind}` };
    }
    entries.push(entry);
    actions.progress?.(entry, "finish");
  }
  const complete = entries.every(entry => entry.snapshot?.coverage.status === "complete");
  const usable = entries.some(entry => entry.snapshot !== undefined || entry.issue?.kind === "permission_denied");
  const status = actions.signal.aborted ? CommandStatus.Cancelled : complete ? CommandStatus.Ok
    : usable ? CommandStatus.Partial : CommandStatus.Failed;
  return { status, output: { mode: "snapshot", entries } };
}
