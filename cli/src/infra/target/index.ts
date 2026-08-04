import { debugEngine, type DebugEngine } from "./debug";
import {
  networkCaptureRuntime,
  type NetworkCaptureRuntime,
} from "./network-capture";
import { packageInstaller, type PackageInstaller } from "./package-install";

/** Capabilities executed against or inside the selected diagnostic target. */
export interface DoctorTargetInfra {
  debugEngine: DebugEngine;
  networkCapture: NetworkCaptureRuntime;
  packageInstaller: PackageInstaller;
}

export const doctorTargetInfra: DoctorTargetInfra = {
  debugEngine,
  networkCapture: networkCaptureRuntime,
  packageInstaller,
};

