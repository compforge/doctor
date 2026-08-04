import type { ProcScan } from "../../fact/process";
import type { ContainerResourceUsage } from "../../fact/resource-usage";
import type { PtraceFacts } from "../../fact/ptrace";
import type { ContainerPlatformFacts } from "../../fact/platform";
import type { CpuPythonFacts } from "./python";
import type { ContainerInfo, TargetPod } from "../../../infra/k8s/target";
import type { DebugEnvironmentFacts } from "../../../infra/target/debug";

export type CpuInspectionFacts = {
  target?: { pod: TargetPod; container: ContainerInfo };
  kubernetes?: { podsExec: boolean; podsEphemeralContainers: boolean };
  container?: { python3: boolean; gdb: boolean; proc: boolean };
  processScan?: ProcScan;
  resourceUsage?: ContainerResourceUsage;
  platform?: ContainerPlatformFacts;
  pickedPid?: number;
  pythonProcess?: CpuPythonFacts;
  ptrace?: PtraceFacts;
  debug?: DebugEnvironmentFacts;
};

export type CpuDiagnosisFacts = CpuInspectionFacts & {
  canExec: boolean;
  hasPython: boolean;
  hasProc: boolean;
};
