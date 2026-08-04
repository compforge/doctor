import type { ApprovalContext } from "../operation";
import type { Executor } from "../../infra/k8s/executor";
import type { ContainerInfo } from "../../infra/k8s/target";

export interface CpuCollectContext extends ApprovalContext {
  exec: Executor;
  podJson: string;
  podName: string;
  container: ContainerInfo;
  log: (line: string) => void;
  notes: string[];
}
