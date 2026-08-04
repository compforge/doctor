import type { KubernetesCommandInput } from "../../command/kubernetes-target";
import type {
  PackageBundle,
  PackageTargetFact,
} from "../../infra/target/package-install";

export const INSTALL_PROGRAMS = ["gdb"] as const;
export type InstallProgram = typeof INSTALL_PROGRAMS[number];
export type InstallReportFormat = "md" | "json";

export interface InstallCliOpts extends KubernetesCommandInput {
  pod?: string;
  container?: string;
  program?: string;
  tar?: string;
  format?: string;
  output?: string;
  yes?: boolean;
}

interface InstallPlanBase {
  packages: readonly string[];
  target: PackageTargetFact;
}

export type InstallPlan =
  | (InstallPlanBase & {
      kind: "offline";
      bundle: PackageBundle;
      reason: "explicit" | "kernel-compatible";
    })
  | (InstallPlanBase & {
      kind: "online";
      commands: readonly string[][];
      fallbackBundle?: PackageBundle;
    })
  | (InstallPlanBase & {
      kind: "unsupported";
      reason: string;
    });
