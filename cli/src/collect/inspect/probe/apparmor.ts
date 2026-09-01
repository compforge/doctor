import type { KubernetesAppArmorUnconfinedInspectionProbe } from "@compforge/doctor-plugin";
import type { Probe } from "../../protocol";
import { PROBE_RUNNABLE, probeUnavailable } from "../../protocol";
import { probeAppArmorUnconfinedAdmission } from "../../../infra/k8s/apparmor";
import type {
  InspectCommandContext,
  InspectConfig,
  InspectFacts,
  InspectObservation,
  KubernetesAppArmorAdmissionObservation,
} from "../model";

interface AdmissionTarget {
  service: string;
  namespace: string;
  serviceAccountName: string;
  image: string;
}

function targets(
  facts: InspectFacts,
  namespace: string,
  serviceName: string,
): AdmissionTarget[] {
  if (facts.serviceTargets.status !== "collected") return [];
  const service = facts.serviceTargets.services[serviceName];
  if (!service) return [];
  const byServiceAccount = new Map<string, AdmissionTarget>();
  for (const pod of Object.values(service.workloads).flatMap((workload) =>
    workload.podRuntime.status === "collected" ? workload.podRuntime.pods : []
  )) {
    const image = pod.containers.find((container) => container.image)?.image;
    if (!image || byServiceAccount.has(pod.serviceAccountName)) continue;
    byServiceAccount.set(pod.serviceAccountName, {
      service: service.service,
      namespace,
      serviceAccountName: pod.serviceAccountName,
      image,
    });
  }
  return [...byServiceAccount.values()]
    .sort((left, right) => left.serviceAccountName.localeCompare(right.serviceAccountName));
}

/** Adapt one Plugin-owned declaration to a best-effort common probe. */
export function makeAppArmorUnconfinedAdmissionProbe(
  serviceName: string,
  declaration: KubernetesAppArmorUnconfinedInspectionProbe,
): Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext> {
  const id = `environment-probe-${serviceName}-${declaration.id}`;
  return {
    id,
    evaluate: (facts, config) => targets(facts, config.namespace, serviceName).length
      ? PROBE_RUNNABLE
      : probeUnavailable(`${serviceName} 没有可用于 AppArmor admission 探测的 ServiceAccount 与镜像`),
    onUnavailable: (ctx, reason) => ctx.bundle.addStep({
      id,
      title: `${serviceName} · Kubernetes AppArmor Unconfined admission`,
      risk: "observe",
      status: "unavailable",
      reason,
    }),
    onFailed: (ctx, reason) => ctx.bundle.addStep({
      id,
      title: `${serviceName} · Kubernetes AppArmor Unconfined admission`,
      risk: "observe",
      status: "unavailable",
      reason,
    }),
    run: async (ctx, facts, config) => {
      const observations: KubernetesAppArmorAdmissionObservation[] = [];
      for (const target of targets(facts, config.namespace, serviceName)) {
        const result = await probeAppArmorUnconfinedAdmission(ctx.executor, target);
        const stepId = `${id}-${target.serviceAccountName}`;
        if (result.status === "unknown") {
          ctx.bundle.addStep({
            id: stepId,
            title: `AppArmor Unconfined · ServiceAccount/${target.serviceAccountName}`,
            risk: "observe",
            status: "unavailable",
            reason: result.reason,
            command: result.result.command,
            durationMs: result.result.durationMs,
          });
          continue;
        }
        const observation: KubernetesAppArmorAdmissionObservation = {
          id: stepId,
          kind: "kubernetes-apparmor-unconfined-admission",
          schemaVersion: 1,
          producer: { origin: "core", id: "kubernetes.apparmor-unconfined-admission" },
          service: target.service,
          probe: declaration.id,
          namespace: target.namespace,
          serviceAccountName: target.serviceAccountName,
          status: result.status,
          reason: result.reason,
        };
        observations.push(observation);
        ctx.bundle.addStep({
          id: stepId,
          title: `AppArmor Unconfined · ServiceAccount/${target.serviceAccountName}`,
          risk: "observe",
          status: "ok",
          reason: result.reason,
          command: result.result.command,
          durationMs: result.result.durationMs,
          output: JSON.stringify(observation, null, 2),
          ext: "json",
        });
      }
      return observations;
    },
  };
}
