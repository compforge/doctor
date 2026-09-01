import type { ProcScan } from "../../fact/process";
import type { ContainerResourceUsage } from "../../fact/resource-usage";
import type { PtraceFacts } from "../../fact/ptrace";
import type { ContainerPlatformFacts } from "../../fact/platform";
import type { CpuPythonFacts } from "./python";
import type { ContainerInfo, TargetPod } from "../../../infra/k8s/target";
import type { DebugEnvironmentFacts } from "../../../infra/target/debug";
import type { CollectedFact } from "../../protocol";

export type CpuInspectionFacts = {
  target?: CollectedFact<{ pod: TargetPod; container: ContainerInfo }, "cpu.target">;
  kubernetes?: CollectedFact<{
    podsExec: boolean;
    podsEphemeralContainers: boolean;
  }, "target.kubernetes-access">;
  container?: CollectedFact<{ python3: boolean; gdb: boolean; proc: boolean }, "target.container-capabilities">;
  processScan?: CollectedFact<ProcScan & { pickedPid?: number }, "target.process-scan">;
  resourceUsage?: CollectedFact<ContainerResourceUsage, "target.resource-usage">;
  platform?: CollectedFact<ContainerPlatformFacts, "target.platform">;
  pythonProcess?: CollectedFact<CpuPythonFacts, "cpu.python-process">;
  ptrace?: CollectedFact<PtraceFacts, "cpu.ptrace">;
  debug?: CollectedFact<DebugEnvironmentFacts, "target.debug-environment">;
};

export type CpuDiagnosisFacts = CpuInspectionFacts;
