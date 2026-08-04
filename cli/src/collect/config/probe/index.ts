import type { Probe } from "../../protocol";
import type {
  ConfigCollectConfig,
  ConfigCollectContext,
  ConfigInspectionFacts,
  ConfigObservation,
} from "../model";
import { makeServiceConfigProbe } from "./service-environment";
import { makeTenantConfigProbe } from "./tenant-config";

export function makeConfigProbes(
  facts: ConfigInspectionFacts,
  config: ConfigCollectConfig,
): Array<Probe<ConfigObservation, ConfigInspectionFacts, ConfigCollectConfig, ConfigCollectContext>> {
  const probes = facts.serviceTargets.status === "collected"
    ? Object.values(facts.serviceTargets.services).flatMap((service) =>
        service.deployments.map((target) => makeServiceConfigProbe(target))
      )
    : [];
  if (config.tenantId && config.tenantConfiguration) {
    probes.push(...config.tenantConfiguration.scopes.map(makeTenantConfigProbe));
  }
  return probes;
}

export * from "./service-environment";
export * from "./tenant-config";
