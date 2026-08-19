import type { Probe } from "../../protocol";
import type {
  InspectCommandContext,
  InspectConfig,
  InspectFacts,
  InspectObservation,
} from "../model";
import { makeServiceConfigProbe } from "./service-environment";
import { makeDependencyInventoryProbe } from "./dependencies";

export function makeInspectProbes(
  facts: InspectFacts,
  config: InspectConfig,
): Array<Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext>> {
  const probes = facts.serviceTargets.status === "collected"
    ? Object.values(facts.serviceTargets.services).flatMap((service) =>
        service.deployments.map((target) => makeServiceConfigProbe(target))
      )
    : [];
  if (facts.dependencyTargets.status === "collected") {
    probes.push(...facts.dependencyTargets.targets.map(makeDependencyInventoryProbe));
  }
  return probes;
}

export * from "./service-environment";
export * from "./dependencies";
