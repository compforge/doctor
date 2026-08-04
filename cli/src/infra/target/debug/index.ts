import { kubernetesDebugEngine } from "./k8s";
import type { DebugEngine } from "./model";

export type {
  DebugCapability,
  DebugEngine,
  DebugEnvironmentFact,
  DebugEnvironmentFacts,
  DebugEnvironmentResolution,
  EphemeralDebugEnvironmentFact,
  DebugGdbFact,
  DebugPreparation,
  DebugPreparationOptions,
  DebugPreparationPreflight,
  DebugTargetImageKeepalive,
} from "./model";
export { DEBUG_CAPABILITIES } from "./model";

/** Public target-side debug engine; callers do not depend on the preparation route. */
export const debugEngine: DebugEngine = kubernetesDebugEngine;
