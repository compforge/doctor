import type { Probe } from "../../protocol";
import type {
  InspectCollectContext,
  InspectConfig,
  InspectFacts,
  InspectObservation,
} from "../model";
import { makeServiceConfigProbe } from "./service-environment";
import { makeTenantConfigProbe } from "./tenant-config";
import { makeDependencyInventoryProbe } from "./dependencies";

export function makeInspectProbes(
  facts: InspectFacts,
  config: InspectConfig,
): Array<Probe<InspectObservation, InspectFacts, InspectConfig, InspectCollectContext>> {
  const probes = facts.serviceTargets.status === "collected"
    ? Object.values(facts.serviceTargets.services).flatMap((service) =>
        service.deployments.map((target) => makeServiceConfigProbe(target))
      )
    : [];
  if (facts.dependencyTargets.status === "collected") {
    probes.push(...facts.dependencyTargets.targets.map(makeDependencyInventoryProbe));
  }
  if (config.tenantId && config.tenantConfiguration) {
    probes.push(...config.tenantConfiguration.scopes.map(makeTenantConfigProbe));
  }
  return probes;
}

export * from "./service-environment";
export * from "./tenant-config";
export * from "./dependencies";
