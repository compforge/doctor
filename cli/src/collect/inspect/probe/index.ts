import type { Probe } from "../../protocol";
import type { ServiceCatalog } from "@compforge/doctor-plugin";
import type {
  InspectCommandContext,
  InspectConfig,
  InspectFacts,
  InspectObservation,
} from "../model";
import { makeServiceConfigProbe } from "./service-environment";
import { makeDependencyInventoryProbe } from "./dependencies";
import { makeAppArmorUnconfinedAdmissionProbe } from "./apparmor";
import { makePluginWorkloadProbe } from "./plugin-workload";

export function makeInspectProbes(
  facts: InspectFacts,
  config: InspectConfig,
  catalog: ServiceCatalog,
): Array<Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext>> {
  const environmentProbes = config.services.flatMap((serviceName) =>
    (catalog.find(serviceName)?.capabilities.environmentProbes ?? []).map((declaration) =>
      makeAppArmorUnconfinedAdmissionProbe(serviceName, declaration)
    )
  );
  const workloadProbes = config.services.flatMap((serviceName) => {
    const service = catalog.find(serviceName);
    return service?.capabilities.workload?.probes.map((probe) =>
      makePluginWorkloadProbe(service, probe)
    ) ?? [];
  });
  const probes: Array<Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext>> = [
    ...environmentProbes,
    ...workloadProbes,
    ...(facts.serviceTargets.status === "collected"
      ? Object.values(facts.serviceTargets.services).flatMap((service) =>
        Object.values(service.workloads).flatMap((workload) =>
          workload.deployments.map((target) => makeServiceConfigProbe(target))
        )
      )
      : []),
  ];
  if (facts.dependencyTargets.status === "collected") {
    probes.push(...facts.dependencyTargets.targets.map(makeDependencyInventoryProbe));
  }
  return probes;
}

export * from "./service-environment";
export * from "./dependencies";
export * from "./apparmor";
export * from "./plugin-workload";
