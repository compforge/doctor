import {
  CASE_PRODUCE_KIND, requireCaseProduceExtension,
  validateCaseProduceResult, validateCaseConsumeResult,
  type CaseConsumeExtension, type CaseConsumeQuery, type CaseConsumeResult,
  type CaseBinding, type CaseProduceResult, type CaseProduceExtension, type CaseProduceQuery,
  type PluginDefinition, type ServiceDefinition, type WorkloadInstance,
} from "@compforge/doctor-plugin";
import type { SendHttp } from "../infra/http";
import { approvalDeniedReason, type ApprovalDecision } from "../command/approval";
import { createDoctorExtensionRegistry } from "../plugin/extension-registry";
import { caseError, checkHttpCase, type CaseAttempt } from "./case-http";

export interface CaseCheckResult {
  consumeExtension: string;
  bindingId?: string;
  consumer: string;
  producer?: CaseBinding["producer"];
  workload?: string;
  startedAt: string;
  finishedAt?: string;
  stage: "consume" | "binding" | "execution" | "provider" | "approval" | "request";
  status: "passed" | "failed" | "unavailable" | "empty" | "cancelled";
  error?: string;
  truncated?: string;
  targets: WorkloadInstance[];
  attempts: CaseAttempt[];
}

export interface CaseCheckActions {
  signal: AbortSignal;
  directory: string;
  /** Core prepares each target independently; one missing curl cannot hide another replica's result. */
  targets(service: ServiceDefinition, binding: CaseBinding): Promise<{ targets: WorkloadInstance[]; truncated?: string }>;
  sender(target: WorkloadInstance): Promise<SendHttp>;
  approve(target: WorkloadInstance, item: CaseProduceResult["cases"][number]): Promise<ApprovalDecision>;
  consume(service: ServiceDefinition, extension: CaseConsumeExtension, query: CaseConsumeQuery): Promise<CaseConsumeResult>;
  produce(service: ServiceDefinition, extension: CaseProduceExtension, query: CaseProduceQuery): Promise<CaseProduceResult>;
  checkpoint(result: CaseCheckResult): void;
}

/** @spec Binding owns the source; provider owns requests; Overview alone schedules and retains failures. */
async function checkCaseBindings(plugin: PluginDefinition, consumer: ServiceDefinition,
  bindings: readonly CaseBinding[], consumeExtension: string, consumeIndex: number, tenantId: string | undefined, actions: CaseCheckActions): Promise<CaseCheckResult[]> {
  const registry = createDoctorExtensionRegistry(plugin);
  const results: CaseCheckResult[] = [];
  for (const [bindingIndex, binding] of bindings.entries()) {
    const result: CaseCheckResult = { consumeExtension, bindingId: binding.id,
      consumer: consumer.name, producer: binding.producer, workload: binding.workload,
      startedAt: new Date().toISOString(), stage: "binding", status: "unavailable", targets: [], attempts: [] };
    results.push(result);
    try {
      actions.signal.throwIfAborted();
      const registered = registry.extensions(CASE_PRODUCE_KIND, binding.producer.namespace)
        .find(entry => entry.extension.id === binding.producer.extension);
      if (!registered?.service) throw new Error(`Missing Service ${CASE_PRODUCE_KIND} provider: ${binding.producer.namespace}/${binding.producer.extension}`);
      const provider = requireCaseProduceExtension(registered.extension);
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
        let provided: CaseProduceResult;
        try {
          provided = await actions.produce(registered.service, provider, query);
          validateCaseProduceResult(provided, query.maxCases);
        } catch (error) {
          result.status = "failed";
          result.error = [result.error, `${target.pod}/${target.container} provider: ${caseError(error)}`].filter(Boolean).join("\n");
          actions.checkpoint(result);
          continue;
        }
        if (provided.reason && provided.cases.length) result.error = [result.error, `${target.pod}/${target.container}: ${caseError(provided.reason)}`].filter(Boolean).join("\n");
        if (provided.truncated) result.truncated = [result.truncated, provided.truncated.reason].filter(Boolean).join("; ");
        if (!provided.cases.length) {
          result.status = "empty";
          result.error = [result.error, `${target.pod}/${target.container}: ${caseError(provided.reason)}`].filter(Boolean).join("\n");
          continue;
        }
        result.stage = "request";
        for (const [caseIndex, item] of provided.cases.entries()) {
          actions.signal.throwIfAborted();
          if (!["GET", "HEAD"].includes(item.case.input.method)) {
            result.stage = "approval";
            const decision = await actions.approve(target, item);
            if (!decision.approved) {
              result.status = "cancelled";
              result.error = [result.error, `${target.pod}/${target.container} ${item.case.id}: ${approvalDeniedReason(decision.source)}`].filter(Boolean).join("\n");
              actions.checkpoint(result);
              continue;
            }
          }
          result.stage = "request";
          result.attempts.push(...await checkHttpCase({ item, target, send, signal: actions.signal,
            directory: actions.directory, prefix: `cases/${encodeURIComponent(consumer.name)}/${consumeIndex}/${bindingIndex}/${targetIndex}/${caseIndex}` }));
          actions.checkpoint(result);
        }
      }
      if (result.attempts.length && result.status !== "cancelled") result.status = result.error || result.truncated || result.attempts.some(attempt => attempt.status === "failed") ? "failed" : "passed";
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

/** @spec Consumer extensions supply relationships; producer extensions supply Cases, never probe results. */
export async function checkServiceCases(plugin: PluginDefinition, consumer: ServiceDefinition,
  extensions: readonly CaseConsumeExtension[], tenantId: string | undefined, actions: CaseCheckActions): Promise<CaseCheckResult[]> {
  const results: CaseCheckResult[] = [];
  for (const [index, extension] of extensions.entries()) {
    const startedAt = new Date().toISOString();
    try {
      actions.signal.throwIfAborted();
      const data = await actions.consume(consumer, extension, { tenantId });
      validateCaseConsumeResult(data);
      results.push(...await checkCaseBindings(plugin, consumer, data.bindings, extension.id, index, tenantId, actions));
    } catch (error) {
      // Discovery failed before a binding exists; retain the responsible extension without inventing a target.
      const result: CaseCheckResult = { consumeExtension: extension.id, consumer: consumer.name,
        startedAt, finishedAt: new Date().toISOString(), stage: "consume",
        status: actions.signal.aborted ? "cancelled" : "unavailable", error: caseError(error), targets: [], attempts: [] };
      results.push(result);
      actions.checkpoint(result);
    }
    if (actions.signal.aborted) break;
  }
  return results;
}
