import type { ServiceVdbStoreCapability } from "@compforge/doctor-plugin";
import type { StoreConfig } from "../config";

export interface VdbConfig {
  collect: StoreConfig["collect"];
  target: StoreConfig["target"];
  store?: string;
  service?: string;
  endpoint?: string;
  output?: string;
}

export function vdbConfigFromStore(config: StoreConfig): VdbConfig {
  const capability = config.capability as ServiceVdbStoreCapability;
  return {
    collect: config.collect,
    target: config.target,
    store: capability.store,
    service: config.backendService,
    endpoint: config.endpoint,
    output: config.output,
  };
}
