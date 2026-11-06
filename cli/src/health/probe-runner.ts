import { validateWorkloadProbeResult,
  type ServiceWorkloadProbeInput, type WorkloadInstance, type ServiceEvidenceObservation, type ServiceFinding } from "@compforge/doctor-plugin";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../command";
import { discoverHealthWorkload } from "./workloads";
import { encodeObservationValue } from "../plugin/observation-value";
import { useLogger } from "../terminal/log";
import { caseOperationInvoker } from "./runtime";
import type { HealthProvider } from "./extensions";

export interface HealthProbeCheck {
  probe: string;
  scope: "self" | "deps";
  status: "ok" | "partial" | "unavailable" | "cancelled" | "not-run";
  reason?: string;
  observations: ServiceEvidenceObservation[];
  findings: ServiceFinding[];
}
/** @spec Cancellation preserves completed evidence, marks the active Probe cancelled and leaves later Probes not-run.
 * @spec Probe acquisition and Detector findings remain separate; an acquired failure is not healthy. */
export async function runHealthProbes(provider: HealthProvider, context: CommandContext, executor: Executor,
  kubernetes: KubectlOptions & { namespace: string },
  healthInput: (instance: WorkloadInstance) => Promise<NonNullable<ServiceWorkloadProbeInput["health"]>>): Promise<HealthProbeCheck[]> {
  const service = provider.service;
  const invoke = caseOperationInvoker(context, executor, kubernetes);
  const results: HealthProbeCheck[] = [];
  for (const probe of provider.probes ?? []) {
    const check: HealthProbeCheck = { probe: probe.id, scope: probe.health!, status: "ok", observations: [], findings: [] };
    results.push(check);
    if (context.signal.aborted) {
      check.status = "not-run";
      check.reason = "执行前已取消";
      continue;
    }
    const label = `${service.name}/${probe.workload}/${probe.id}`;
    useLogger("health").info(`执行 ${check.scope} Probe：${label}`);
    try {
      const discovered = await discoverHealthWorkload(service, probe.workload, context, executor, kubernetes);
      if (discovered.instances.length > 10) { check.status = "partial"; check.reason = `仅检查 ${discovered.instances.length} 个实例中的前 10 个`; }
      // @rule Retained placeholder Values are not evidence that an instance was acquired.
      let usableInstances = 0;
      for (const discoveredInstance of discovered.instances.slice(0, 10)) {
        const pod = discovered.pods.find(item => item.name === discoveredInstance.pod);
        const instance = { ...discoveredInstance, container: discoveredInstance.container
          ?? (pod?.containers.length === 1 ? pod.containers[0]!.name : undefined) };
        context.signal.throwIfAborted();
        try {
          const health = await healthInput(instance);
          context.signal.throwIfAborted();
          const observed = await invoke(service, probe, { instance, facts: [], health });
          validateWorkloadProbeResult(observed);
          const encoded = encodeObservationValue(probe.produces, observed.value, label);
          check.observations.push({ id: `${label}/${instance.pod}`, services: [service.name], probe: probe.id,
            kind: `plugin/${context.plugin.id}/${service.name}/${probe.produces.kind}`, schemaVersion: probe.produces.schemaVersion,
            producer: { origin: "plugin", plugin: context.plugin.id, service: service.name, id: probe.id }, workload: probe.workload, instance, value: encoded.value });
          if (observed.status !== "unavailable") usableInstances++;
          if (observed.status !== "ok") {
            check.status = "partial";
            check.reason = [check.reason, `${instance.pod}: ${observed.reason}`].filter(Boolean).join("; ");
          }
        } catch (error) {
          if (context.signal.aborted) {
            check.status = "cancelled";
            check.reason = "执行中已取消，保留已取得的证据";
            break;
          }
          check.status = "partial";
          const reason = `${instance.pod}: ${error instanceof Error ? error.message : String(error)}`;
          check.reason = check.reason ? `${check.reason}; ${reason}` : reason;
        }
      }
      if (!usableInstances && check.status !== "cancelled") check.status = "unavailable";
      for (const detector of service.detectors ?? []) check.findings.push(...detector.detect({ facts: [], observations: check.observations }));
    } catch (error) { check.status = context.signal.aborted ? "cancelled" : "unavailable"; check.reason = context.signal.aborted ? "执行中已取消，保留已取得的证据" : error instanceof Error ? error.message : String(error); }
    useLogger("health").info(`Probe 完成：${label} · ${check.status} · ${check.findings.length} 条 Finding${check.reason ? ` · ${check.reason}` : ""}`);
  }
  return results;
}
