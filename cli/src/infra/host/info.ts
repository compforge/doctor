import { cpus, release, totalmem } from "node:os";

export interface DoctorHostInfo {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly kernelRelease: string;
  readonly glibcVersion?: string;
  readonly cpu: {
    readonly logicalCount: number;
    readonly model?: string;
  };
  readonly totalMemoryBytes: number;
  readonly runtime: {
    readonly name: "bun" | "node";
    readonly version: string;
  };
}

function runtimeGlibcVersion(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const report = process.report?.getReport() as
    | { readonly header?: { readonly glibcVersionRuntime?: unknown } }
    | undefined;
  const value = report?.header?.glibcVersionRuntime;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Facts about the machine running Doctor; Target facts belong to each domain Inspect. */
export function getDoctorHostInfo(): DoctorHostInfo {
  const processors = cpus();
  const bunVersion = process.versions.bun;
  return {
    platform: process.platform,
    architecture: process.arch,
    kernelRelease: release(),
    glibcVersion: runtimeGlibcVersion(),
    cpu: {
      logicalCount: processors.length,
      model: processors[0]?.model?.trim() || undefined,
    },
    totalMemoryBytes: totalmem(),
    runtime: {
      name: bunVersion ? "bun" : "node",
      version: bunVersion ?? process.versions.node,
    },
  };
}
