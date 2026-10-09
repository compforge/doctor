import {
  caseProducer, validateHealthCaseBindingsResult,
  type HealthCaseBinding, type HealthCaseBindingsExtension, type HealthCaseBindingsQuery, type HealthCaseBindingsResult,
  type CaseProducer, type ServiceCaseSource, type CaseProduceQuery, type PluginDefinition, type ServiceDefinition, type ServiceRequestIdentity,
} from "@compforge/doctor-plugin";
import { caseError } from "../case/http-check";
import type { CaseCheckResult } from "./cases";

export interface PreparedCaseCheck {
  result: CaseCheckResult;
  execution?: {
    consumer: ServiceDefinition;
    binding: HealthCaseBinding;
    consumeIndex: number;
    bindingIndex: number;
    service: ServiceDefinition;
    source: ServiceCaseSource;
    query: CaseProduceQuery;
  };
}

export interface CasePrepareActions {
  signal: AbortSignal;
  consume(service: ServiceDefinition, extension: HealthCaseBindingsExtension, query: HealthCaseBindingsQuery): Promise<HealthCaseBindingsResult>;
  identity(producer: CaseProducer): Promise<ServiceRequestIdentity | undefined>;
  tenant?(producer: CaseProducer): Promise<string | undefined>;
}

/** @spec Resolve only selected dependencies and identities in Command.prepare; never generate Cases or enter consumer Pods. */
export async function prepareServiceCases(plugin: PluginDefinition, consumer: ServiceDefinition,
  extensions: readonly HealthCaseBindingsExtension[], tenantId: string | undefined, actions: CasePrepareActions): Promise<PreparedCaseCheck[]> {
  const prepared: PreparedCaseCheck[] = [];
  for (const [consumeIndex, extension] of extensions.entries()) {
    const base = (): CaseCheckResult => ({
      consumeExtension: extension.id, consumer: consumer.name, startedAt: new Date().toISOString(),
      stage: "consume", status: "unavailable", targets: [], attempts: [],
    });
    try {
      actions.signal.throwIfAborted();
      const data = await actions.consume(consumer, extension, { tenantId });
      validateHealthCaseBindingsResult(data);
      for (const [bindingIndex, binding] of data.bindings.entries()) {
        const result: CaseCheckResult = { ...base(), bindingId: binding.id, producer: binding.producer,
          workload: binding.workload, stage: "binding" };
        const check: PreparedCaseCheck = { result };
        prepared.push(check);
        try {
          actions.signal.throwIfAborted();
          const registered = plugin.services.caseSource(binding.producer);
          const producer = caseProducer(registered.source);
          if (!consumer.workloads.some(workload => workload.name === binding.workload)) throw new Error(`Unknown consumer Workload: ${binding.workload}`);
          result.stage = "identity";
          const requestIdentity = producer.requestIdentity ? await actions.identity(producer) : undefined;
          let requestTenantId: string | undefined;
          if (producer.requestTenant) {
            if (!actions.tenant) throw new Error("Missing tenant preparation");
            requestTenantId = await actions.tenant(producer);
          }
          if ((producer.requestIdentity && !requestIdentity) || (producer.requestTenant && !requestTenantId)) {
            result.status = "cancelled";
            result.error = "已取消 Case 身份选择，未执行检查";
          } else {
            check.execution = { consumer, binding, consumeIndex, bindingIndex, service: registered.service,
              source: registered.source, query: { tenantId, requestIdentity, requestTenantId, maxCases: 10 } };
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
