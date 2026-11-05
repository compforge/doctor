import { executionDiagnostic, type ExecutionDiagnostic } from "../command/diagnostic";
import { ToolboxError, type ErrorKind } from "@compforge/harness-toolbox/errors";
import { immutableJsonValue, type JsonObject, type Summary } from "@compforge/harness-common";
import { validateResourceSnapshot, type Resource, type ResourceSnapshot, type ResourceQuery, type OperationResult } from "@compforge/doctor-plugin";
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
}): Promise<{ status: CommandStatus; output: ResourceResult; diagnostics: ExecutionDiagnostic[] }> {
  const entries: ResourceEntry[] = [];
  const diagnostics: ExecutionDiagnostic[] = [];
  for (const provider of providers) {
    if (actions.signal.aborted) break;
    const entry = resourceDeclaration(provider);
    actions.progress?.(entry, "start");
    const startedAt = Date.now();
    let validating = false;
    try {
      const { result, environment } = await actions.observe(provider, query);
      validating = true;
      validateResourceSnapshot(result.data, { resource: entry.resource, environment }, query);
      // Freeze the evidence before starting another provider; never serialize live Plugin objects.
      entry.snapshot = immutableJsonValue(result.data, "Resource snapshot") as unknown as ResourceSnapshot<JsonObject>;
      entry.summary = immutableJsonValue(result.summary, "Resource summary") as unknown as Summary;
    } catch (error) {
      const kind = error instanceof ToolboxError ? error.kind : validating ? "invalid_response" : "operation_failed";
      diagnostics.push(executionDiagnostic(error, { phase: validating ? "resource.validation" : "resource.observe",
        target: `${entry.service}/${entry.resource.id}`, startedAt, kind: actions.signal.aborted ? "cancelled" : kind }));
      if (actions.signal.aborted) break;
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
  return { status, output: { mode: "snapshot", entries }, diagnostics };
}
