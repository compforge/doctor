import { ENDPOINT_PROBE_KIND, type EndpointProbeExtension, validateWorkloadProbeResult,
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
 * @spec Health invokes each Probe once per Workload using its first discovered instance, not once per replica.
 * @spec Probe acquisition and Detector findings remain separate; an acquired failure is not healthy. */
export async function runHealthProbes(provider: HealthProvider, context: CommandContext, executor: Executor,
  kubernetes: KubectlOptions & { namespace: string },
  healthInput: (instance: WorkloadInstance) => Promise<NonNullable<ServiceWorkloadProbeInput["health"]>>,
  endpointProbes: readonly EndpointProbeExtension[] = []): Promise<HealthProbeCheck[]> {
  const service = provider.service;
  const invoke = caseOperationInvoker(context, executor, kubernetes);
  const results: HealthProbeCheck[] = [];
  for (const probe of [...provider.probes ?? [], ...endpointProbes]) {
    const check: HealthProbeCheck = { probe: probe.id, scope: probe.kind === ENDPOINT_PROBE_KIND ? "deps" : probe.health!, status: "ok", observations: [], findings: [] };
    results.push(check);
    if (context.signal.aborted) {
      check.status = "not-run";
      check.reason = "执行前已取消";
      continue;
    }
    const label = `${service.name}/${probe.kind === ENDPOINT_PROBE_KIND ? probe.workload.name : probe.workload}/${probe.id}`;
    useLogger("health").info(`执行 ${check.scope} Probe：${label}`);
    try {
      const workload = probe.kind === ENDPOINT_PROBE_KIND ? probe.workload : service.workloads.find(item => item.name === probe.workload);
      if (!workload) throw new Error(`未声明 Workload ${probe.workload}`);
      const discovered = await discoverHealthWorkload(workload, context, executor, kubernetes);
      // @rule Retained placeholder Values are not evidence that an instance was acquired.
      let usableInstances = 0;
      for (const discoveredInstance of discovered.instances.slice(0, 1)) {
        const pod = discovered.pods.find(item => item.name === discoveredInstance.pod);
        const instance = { ...discoveredInstance, container: discoveredInstance.container
          ?? (pod?.containers.length === 1 ? pod.containers[0]!.name : undefined) };
        context.signal.throwIfAborted();
        try {
          const observed = probe.kind === ENDPOINT_PROBE_KIND
            ? await invoke(service, probe, { instance })
            : await invoke(service, probe, { instance, facts: [], health: await healthInput(instance) });
          validateWorkloadProbeResult(observed);
          const encoded = encodeObservationValue(probe.produces, observed.value, label);
          check.observations.push({ id: `${label}/${instance.pod}`, services: [service.name], probe: probe.id,
            kind: `plugin/${context.plugin.id}/${service.name}/${probe.produces.kind}`, schemaVersion: probe.produces.schemaVersion,
            producer: { origin: "plugin", plugin: context.plugin.id, service: service.name, id: probe.id }, workload: workload.name, instance, value: encoded.value });
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
    useLogger("health")[check.status === "unavailable" ? "warn" : "info"](`Probe 完成：${label} · ${check.status} · ${check.findings.length} 条 Finding${check.reason ? ` · ${check.reason}` : ""}`);
  }
  return results;
}
