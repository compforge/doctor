import type { ApprovalContext } from "../operation";
import type { Executor } from "../../infra/k8s/executor";
import type { ContainerInfo } from "../../infra/k8s/target";
import type { CommandContext } from "../../command";
import type { CpuConfig } from "./config";

export interface CpuCommandContext extends ApprovalContext {
  command: CommandContext;
  config: CpuConfig;
  exec: Executor;
  target: { pod: string; container?: string };
  podJson: string;
  podName: string;
  container: ContainerInfo;
  log: (line: string) => void;
  notes: string[];
}
