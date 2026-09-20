import { workloadProbeProviders } from "../../../plugin/workload-extensions";
import type { Probe } from "../../protocol";
import type { ServiceCatalog, ServiceEvidenceFact } from "@compforge/doctor-plugin";
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
  probeFacts: readonly ServiceEvidenceFact[],
): Array<Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext>> {
  const serviceProbes = config.services.flatMap((serviceName) => {
    const service = catalog.find(serviceName);
    const environment = service?.contributions?.probes?.filter(probe => probe.kind !== "workload")
      .map(probe => makeAppArmorUnconfinedAdmissionProbe(serviceName, probe)) ?? [];
    const workloads = workloadProbeProviders(catalog, serviceName)
      .map(({ service, extension }) => makePluginWorkloadProbe(service, extension, probeFacts));
    return [...environment, ...workloads];
  });
  const probes: Array<Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext>> = [
    ...serviceProbes,
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
