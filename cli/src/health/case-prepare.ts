import {
  CASE_PRODUCE_KIND, requireCaseProduceExtension, validateCaseConsumeResult,
  type CaseBinding, type CaseConsumeExtension, type CaseConsumeQuery, type CaseConsumeResult,
  type CaseProduceExtension, type PluginDefinition, type ServiceDefinition, type ServiceRequestIdentity,
} from "@compforge/doctor-plugin";
import { createDoctorExtensionRegistry } from "../plugin/extension-registry";
import { caseError } from "./case-http";
import type { CaseCheckResult } from "./cases";

export interface PreparedCaseCheck {
  result: CaseCheckResult;
  execution?: {
    consumer: ServiceDefinition;
    binding: CaseBinding;
    consumeIndex: number;
    bindingIndex: number;
    service: ServiceDefinition;
    producer: CaseProduceExtension;
    query: { tenantId?: string; requestIdentity?: ServiceRequestIdentity; maxCases: number };
  };
}

export interface CasePrepareActions {
  signal: AbortSignal;
  consume(service: ServiceDefinition, extension: CaseConsumeExtension, query: CaseConsumeQuery): Promise<CaseConsumeResult>;
  identity(extension: CaseProduceExtension): Promise<ServiceRequestIdentity | undefined>;
}

/** @spec Resolve only selected dependencies and identities in Command.prepare; never generate Cases or enter consumer Pods. */
export async function prepareServiceCases(plugin: PluginDefinition, consumer: ServiceDefinition,
  extensions: readonly CaseConsumeExtension[], tenantId: string | undefined, actions: CasePrepareActions): Promise<PreparedCaseCheck[]> {
  const registry = createDoctorExtensionRegistry(plugin);
  const prepared: PreparedCaseCheck[] = [];
  for (const [consumeIndex, extension] of extensions.entries()) {
    const base = (): CaseCheckResult => ({
      consumeExtension: extension.id, consumer: consumer.name, startedAt: new Date().toISOString(),
      stage: "consume", status: "unavailable", targets: [], attempts: [],
    });
    try {
      actions.signal.throwIfAborted();
      const data = await actions.consume(consumer, extension, { tenantId });
      validateCaseConsumeResult(data);
      for (const [bindingIndex, binding] of data.bindings.entries()) {
        const result: CaseCheckResult = { ...base(), bindingId: binding.id, producer: binding.producer,
          workload: binding.workload, stage: "binding" };
        const check: PreparedCaseCheck = { result };
        prepared.push(check);
        try {
          actions.signal.throwIfAborted();
          const registered = registry.extensions(CASE_PRODUCE_KIND, binding.producer.namespace)
            .find(entry => entry.extension.id === binding.producer.extension);
          if (!registered?.service) throw new Error(`Missing Service ${CASE_PRODUCE_KIND} provider: ${binding.producer.namespace}/${binding.producer.extension}`);
          const producer = requireCaseProduceExtension(registered.extension);
          if (!consumer.workloads.some(workload => workload.name === binding.workload)) throw new Error(`Unknown consumer Workload: ${binding.workload}`);
          result.stage = "identity";
          const requestIdentity = producer.requestIdentity ? await actions.identity(producer) : undefined;
          if (producer.requestIdentity && !requestIdentity) {
            result.status = "cancelled";
            result.error = "已取消 Case 身份选择，未执行检查";
          } else {
            check.execution = { consumer, binding, consumeIndex, bindingIndex, service: registered.service,
              producer, query: { tenantId, requestIdentity, maxCases: 10 } };
          }
        } catch (error) {
          result.error = caseError(error);
          result.status = actions.signal.aborted ? "cancelled" : "unavailable";
        }
        if (!check.execution) result.finishedAt = new Date().toISOString();
        if (actions.signal.aborted) break;
      }
    } catch (error) {
      prepared.push({ result: { ...base(), error: caseError(error), finishedAt: new Date().toISOString(),
        status: actions.signal.aborted ? "cancelled" : "unavailable" } });
    }
    if (actions.signal.aborted) break;
  }
  return prepared;
}
