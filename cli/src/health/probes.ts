import { SERVICE_DOWNSTREAMS_KIND, requireServiceDownstreamsExtension, validateWorkloadProbeResult,
  type ServiceDefinition, type ServiceDownstream, type ServiceEvidenceObservation, type ServiceFinding } from "@compforge/doctor-plugin";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../command";
import { discoverKubernetesWorkload } from "../infra/k8s/workload";
import { enforceKubernetesAccess } from "../terminal/kubernetes-access";
import { encodeObservationValue } from "../plugin/observation-value";
import { useLogger } from "../terminal/log";
import { caseOperationInvoker } from "./case-runtime";
import type { HealthProvider } from "./extensions";

export interface HealthProbeCheck {
  probe: string;
  scope: "self" | "deps";
  status: "ok" | "partial" | "unavailable";
  reason?: string;
  observations: ServiceEvidenceObservation[];
  findings: ServiceFinding[];
}
export type HealthScope = "self" | "deps" | "business";
export function healthScopes(value = "all"): readonly HealthScope[] {
  if (value === "all") return ["self", "deps", "business"];
  const scopes = value.split(",");
  if (!scopes.length || scopes.some(scope => !["self", "deps", "business"].includes(scope))) {
    throw new Error("--scope 必须为 self、deps、business 的逗号组合或 all");
  }
  return [...new Set(scopes)] as HealthScope[];
}

export function validateDownstreams(service: ServiceDefinition, services: readonly ServiceDefinition[], values: readonly ServiceDownstream[]): void {
  if (!Array.isArray(values)) throw new Error("service.downstreams 必须返回列表");
  const ids = new Set<string>();
  for (const value of values) {
    if (!value?.id || ids.has(value.id) || !services.some(item => item.name === value.service)
      || !service.workloads.some(workload => workload.name === value.workload)
      || typeof value.endpoint?.host !== "string" || !value.endpoint.host.trim() || /[\s/\\?#@]/.test(value.endpoint.host)
      || !Number.isInteger(value.endpoint.port) || value.endpoint.port < 1 || value.endpoint.port > 65535
      || (value.endpoint.tls !== undefined && typeof value.endpoint.tls !== "boolean")) {
      throw new Error("service.downstreams 返回了无效、未声明或重复的下游关系");
    }
    ids.add(value.id);
  }
}

/** @spec Probe acquisition and Detector findings remain separate; an acquired failure is not healthy. */
export async function checkHealthProbes(provider: HealthProvider, context: CommandContext, executor: Executor,
  kubernetes: KubectlOptions & { namespace: string }, bizId?: string): Promise<HealthProbeCheck[]> {
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
      for (const discoveredInstance of discovered.instances.slice(0, 10)) {
        const pod = discovered.pods.find(item => item.name === discoveredInstance.pod);
        const instance = { ...discoveredInstance, container: discoveredInstance.container
          ?? (pod?.containers.length === 1 ? pod.containers[0]!.name : undefined) };
        context.signal.throwIfAborted();
        try {
          const downstreams: ServiceDownstream[] = [];
          if (probe.health === "deps") {
            for (const extension of service.extensions ?? []) {
              if (extension.kind !== SERVICE_DOWNSTREAMS_KIND || (extension.namespace && extension.namespace !== provider.namespace)) continue;
              downstreams.push(...await invoke(service, requireServiceDownstreamsExtension(extension), { instance, bizId }));
            }
            validateDownstreams(service, context.plugin.services.services, downstreams);
          }
          const observed = await invoke(service, probe, { instance, facts: [], health: { bizId, downstreams } });
          validateWorkloadProbeResult(observed);
          const encoded = encodeObservationValue(probe.produces, observed.value, label);
          check.observations.push({ id: `${label}/${instance.pod}`, services: [service.name], probe: probe.id,
            kind: `plugin/${context.plugin.id}/${service.name}/${probe.produces.kind}`, schemaVersion: probe.produces.schemaVersion,
            producer: { origin: "plugin", plugin: context.plugin.id, service: service.name, id: probe.id }, workload: probe.workload, instance, value: encoded.value });
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
      if (!check.observations.length) check.status = "unavailable";
      for (const detector of service.detectors ?? []) check.findings.push(...detector.detect({ facts: [], observations: check.observations }));
    } catch (error) { check.status = "unavailable"; check.reason = error instanceof Error ? error.message : String(error); }
    useLogger("health").info(`Probe 完成：${label} · ${check.status} · ${check.findings.length} 条 Finding${check.reason ? ` · ${check.reason}` : ""}`);
  }
  return results;
}
