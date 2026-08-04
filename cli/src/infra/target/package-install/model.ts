import type { ExecResult, Executor } from "../../k8s/executor";

export type PackageManagerKind = "apk" | "apt-get" | "dnf" | "microdnf" | "yum";

export interface PackageManager {
  kind: PackageManagerKind;
  path: string;
  version?: string;
}

export interface TargetLibcFact {
  family?: string;
  version?: string;
  raw?: string;
}

export interface TargetPythonFact {
  executable?: string;
  implementation?: string;
  version?: string;
}

export interface TargetCpuFact {
  model?: string;
  flags?: string[];
}

export interface TargetSecurityFact {
  capEff?: string;
  noNewPrivs?: string;
  ptraceScope?: string;
  seccomp?: string;
}

export interface PackageTargetFact {
  manager: PackageManager;
  osId?: string;
  osVersionId?: string;
  osPrettyName?: string;
  architecture?: string;
  kernelVersion?: string;
  kernelMachine?: string;
  kernelBuild?: string;
  libc?: TargetLibcFact;
  python?: TargetPythonFact;
  cpu?: TargetCpuFact;
  security?: TargetSecurityFact;
  pythonAvailable: boolean;
  tarAvailable: boolean;
}

export interface PackageKernelCompatibility {
  minInclusive?: string;
  maxExclusive?: string;
}

export interface PackageBundleManifest {
  schema: "doctor-packages/v1";
  bundleVersion: string;
  packageManager: PackageManagerKind;
  osId: string;
  osVersionId: string;
  architecture: string;
  packages: string[];
  packageVersions?: Record<string, string>;
  compatibility?: {
    kernel?: PackageKernelCompatibility;
  };
}

export interface PackageBundle {
  path: string;
  manifest: PackageBundleManifest;
  variant?: {
    id: string;
    entryPath: string;
    sha256: string;
    setVersion: string;
  };
}

export interface MaterializedPackageBundle {
  path: string;
  cleanup: () => void;
}

export interface PackageInstaller {
  inspect(
    executor: Executor,
    pod: string,
    container: string,
  ): Promise<PackageTargetFact | undefined>;
  installed(
    executor: Executor,
    pod: string,
    container: string,
    target: PackageTargetFact,
    packages: readonly string[],
  ): Promise<boolean>;
  installOnline(
    executor: Executor,
    pod: string,
    container: string,
    target: PackageTargetFact,
    packages: readonly string[],
  ): Promise<ExecResult>;
  installBundle(
    executor: Executor,
    pod: string,
    container: string,
    target: PackageTargetFact,
    packages: readonly string[],
    remoteTarPath: string,
  ): Promise<ExecResult>;
}
