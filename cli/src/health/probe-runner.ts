import { validateWorkloadProbeResult,
  type ServiceWorkloadProbeInput, type WorkloadInstance, type ServiceEvidenceObservation, type ServiceFinding } from "@compforge/doctor-plugin";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../command";
import { discoverKubernetesWorkload } from "../infra/k8s/workload";
import { enforceKubernetesAccess } from "../terminal/kubernetes-access";
import { encodeObservationValue } from "../plugin/observation-value";
import { useLogger } from "../terminal/log";
import { caseOperationInvoker } from "./runtime";
import type { HealthProvider } from "./extensions";

export interface HealthProbeCheck {
  probe: string;
  scope: "self" | "deps";
  status: "ok" | "partial" | "unavailable";
  reason?: string;
  observations: ServiceEvidenceObservation[];
  findings: ServiceFinding[];
}
/** @spec Probe acquisition and Detector findings remain separate; an acquired failure is not healthy. */
export async function runHealthProbes(provider: HealthProvider, context: CommandContext, executor: Executor,
  kubernetes: KubectlOptions & { namespace: string },
  healthInput: (instance: WorkloadInstance) => Promise<NonNullable<ServiceWorkloadProbeInput["health"]>>): Promise<HealthProbeCheck[]> {
  const service = provider.service;
  const invoke = caseOperationInvoker(context, executor, kubernetes);
  const results: HealthProbeCheck[] = [];
  for (const probe of provider.probes ?? []) {
    if (context.signal.aborted) break;
    const check: HealthProbeCheck = { probe: probe.id, scope: probe.health!, status: "ok", observations: [], findings: [] };
    results.push(check);
    const label = `${service.name}/${probe.workload}/${probe.id}`;
    useLogger("health").info(`执行 ${check.scope} Probe：${label}`);
    try {
      const { environment } = await context.environment(executor);
      const workload = service.workloads.find(item => item.name === probe.workload);
      if (!workload) throw new Error(`未声明 Workload ${probe.workload}`);
      const location = workload.location;
      const resource = location.kind === "service" ? "services" : location.kind === "resource" ? `${location.resource_kind.toLowerCase()}s` : undefined;
      await enforceKubernetesAccess(context.kubernetes(executor).access, { command: "doctor health", needs: [
        { rule: { verb: "list", resource: "pods" }, requirement: "required", purpose: "定位 Health Probe 实例" },
        ...(resource ? [{ rule: { verb: "get", resource, resourceName: location.kind === "labels" ? undefined : location.name },
          requirement: "required" as const, purpose: "解析 Health Probe Workload" }] : []),
      ] });
      const discovered = await discoverKubernetesWorkload(workload, executor, kubernetes.namespace, environment.name, () => {});
      if (discovered.unavailableReason) throw new Error(discovered.unavailableReason);
      if (!discovered.instances.length) throw new Error("未发现实例，无法判断健康状态");
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
          check.status = "partial";
          const reason = `${instance.pod}: ${error instanceof Error ? error.message : String(error)}`;
          check.reason = check.reason ? `${check.reason}; ${reason}` : reason;
        }
      }
      if (!usableInstances) check.status = "unavailable";
      for (const detector of service.detectors ?? []) check.findings.push(...detector.detect({ facts: [], observations: check.observations }));
    } catch (error) { check.status = "unavailable"; check.reason = error instanceof Error ? error.message : String(error); }
    useLogger("health").info(`Probe 完成：${label} · ${check.status} · ${check.findings.length} 条 Finding${check.reason ? ` · ${check.reason}` : ""}`);
  }
  return results;
}
