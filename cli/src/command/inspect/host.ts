import { cpus, release, totalmem } from "node:os";

export interface DoctorHostInspection {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly kernelRelease: string;
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

/** Facts about the machine running Doctor; Target facts belong to each domain Inspect. */
export async function inspectDoctorHost(): Promise<DoctorHostInspection> {
  const processors = cpus();
  const bunVersion = process.versions.bun;
  return {
    platform: process.platform,
    architecture: process.arch,
    kernelRelease: release(),
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
