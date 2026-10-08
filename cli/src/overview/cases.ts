import {
  CASE_HTTP_PROVIDE_KIND, requireHttpCaseProviderExtension,
  validateHttpCasesResult,
  type CaseBinding, type HttpCasesResult, type HttpCaseProviderExtension, type HttpCaseQuery,
  type PluginDefinition, type ServiceDefinition, type WorkloadInstance,
} from "@compforge/doctor-plugin";
import type { SendHttp } from "../infra/http";
import { createDoctorExtensionRegistry } from "../plugin/extension-registry";
import { caseError, executeHttpCase, type CaseAttempt } from "./case-http";

export type OverviewCaseBinding = CaseBinding;
export interface CaseCheckResult {
  bindingId: string;
  consumer: string;
  provider: CaseBinding["provider"];
  workload: string;
  startedAt: string;
  finishedAt?: string;
  stage: "binding" | "execution" | "provider" | "request";
  status: "passed" | "failed" | "unavailable" | "empty" | "cancelled";
  error?: string;
  truncated?: string;
  targets: WorkloadInstance[];
  attempts: CaseAttempt[];
}

export function serviceCaseBindings(service: ServiceDefinition): OverviewCaseBinding[] {
  return [...(service.caseBindings ?? [])];
}

export interface CaseCheckActions {
  signal: AbortSignal;
  directory: string;
  /** Core prepares each target independently; one missing curl cannot hide another replica's result. */
  targets(service: ServiceDefinition, binding: CaseBinding): Promise<{ targets: WorkloadInstance[]; truncated?: string }>;
  sender(target: WorkloadInstance): Promise<SendHttp>;
  provide(service: ServiceDefinition, extension: HttpCaseProviderExtension, query: HttpCaseQuery): Promise<HttpCasesResult>;
  checkpoint(result: CaseCheckResult): void;
}

/** @spec Binding owns the source; provider owns requests; Overview alone schedules and retains failures. */
export async function checkServiceCases(plugin: PluginDefinition, consumer: ServiceDefinition,
  bindings: readonly OverviewCaseBinding[], tenantId: string | undefined, actions: CaseCheckActions): Promise<CaseCheckResult[]> {
  const registry = createDoctorExtensionRegistry(plugin);
  const results: CaseCheckResult[] = [];
  for (const [bindingIndex, binding] of bindings.entries()) {
    const result: CaseCheckResult = { bindingId: binding.id,
      consumer: consumer.name, provider: binding.provider, workload: binding.workload,
      startedAt: new Date().toISOString(), stage: "binding", status: "unavailable", targets: [], attempts: [] };
    results.push(result);
    try {
      actions.signal.throwIfAborted();
      const registered = registry.extensions(CASE_HTTP_PROVIDE_KIND, binding.provider.namespace)
        .find(entry => entry.extension.id === binding.provider.extension);
      if (!registered?.service) throw new Error(`Missing Service ${CASE_HTTP_PROVIDE_KIND} provider: ${binding.provider.namespace}/${binding.provider.extension}`);
      const provider = requireHttpCaseProviderExtension(registered.extension);
      if (!consumer.workloads.some(workload => workload.name === binding.workload)) throw new Error(`Unknown consumer Workload: ${binding.workload}`);
      result.stage = "execution";
      const discovery = await actions.targets(consumer, binding);
      result.targets = discovery.targets;
      result.truncated = discovery.truncated;
      if (!result.targets.length) throw new Error("No runnable consumer Pod/Container");
      for (const [targetIndex, target] of result.targets.entries()) {
        actions.signal.throwIfAborted();
        result.stage = "execution";
        let send: SendHttp;
        try { send = await actions.sender(target); }
        catch (error) {
          result.error = [result.error, `${target.pod}/${target.container}: ${caseError(error)}`].filter(Boolean).join("\n");
          actions.checkpoint(result);
          continue;
        }
        result.stage = "provider";
        // Resolve fresh URLs after Pod readiness, once per target; signed links must not age in a queue.
        const query = { tenantId, maxCases: 10 };
        let provided: HttpCasesResult;
        try {
          provided = await actions.provide(registered.service, provider, query);
          validateHttpCasesResult(provided, query.maxCases);
        } catch (error) {
          result.status = "failed";
          result.error = [result.error, `${target.pod}/${target.container} provider: ${caseError(error)}`].filter(Boolean).join("\n");
          actions.checkpoint(result);
          continue;
        }
        if (provided.truncated) result.truncated = [result.truncated, provided.truncated.reason].filter(Boolean).join("; ");
        if (!provided.cases.length) {
          result.status = "empty";
          result.error = [result.error, `${target.pod}/${target.container}: ${caseError(provided.reason)}`].filter(Boolean).join("\n");
          continue;
        }
        result.stage = "request";
        for (const [caseIndex, item] of provided.cases.entries()) {
          actions.signal.throwIfAborted();
          result.attempts.push(...await executeHttpCase({ item, target, send, signal: actions.signal,
            directory: actions.directory, prefix: `cases/${encodeURIComponent(consumer.name)}/${bindingIndex}/${targetIndex}/${caseIndex}` }));
          actions.checkpoint(result);
        }
      }
      if (result.attempts.length) result.status = result.error || result.truncated || result.attempts.some(attempt => attempt.status === "failed") ? "failed" : "passed";
    } catch (error) {
      result.error = [result.error, caseError(error)].filter(Boolean).join("\n");
      result.status = actions.signal.aborted ? "cancelled" : result.stage === "request" || result.stage === "provider" ? "failed" : "unavailable";
    } finally {
      if (actions.signal.aborted) result.status = "cancelled";
      result.finishedAt = new Date().toISOString();
      actions.checkpoint(result);
    }
    if (actions.signal.aborted) break;
  }
  return results;
}
