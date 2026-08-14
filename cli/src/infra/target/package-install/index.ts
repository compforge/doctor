import { kubernetesPackageInstaller } from "./k8s";
import type { PackageInstaller } from "./model";

export { onlineInstallCommands } from "./k8s";
export {
  bundleMatches,
  bundlePlatformMatches,
  inspectPackageBundle,
  matchingPackageBundles,
  packageBundleRequirements,
  selectPackageBundle,
} from "./archive";
export {
  discoverPackageBundles,
  inspectPackageBundles,
} from "./distribution";
export { materializePackageBundle } from "./set";
export type {
  MaterializedPackageBundle,
  PackageBundle,
  PackageBundleManifest,
  PackageInstaller,
  PackageManager,
  PackageManagerKind,
  PackageTargetFact,
} from "./model";

export const packageInstaller: PackageInstaller = kubernetesPackageInstaller;
