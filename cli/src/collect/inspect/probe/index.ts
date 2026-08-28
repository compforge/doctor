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
  const probes: Array<Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext>> = [
    ...environmentProbes,
    ...(facts.serviceTargets.status === "collected"
      ? Object.values(facts.serviceTargets.services).flatMap((service) =>
        service.deployments.map((target) => makeServiceConfigProbe(target))
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
