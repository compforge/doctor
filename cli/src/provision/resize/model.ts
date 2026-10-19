import type { KubernetesCommandInput } from "../../command/kubernetes-target";
import type { ApprovalDecision } from "../../command/approval";
import type { MemoryHierarchy, MemoryLimitChange, MemoryResizeTarget } from "../../infra/target/memory-resize";

export interface ResizeCliOpts extends KubernetesCommandInput {
  pod?: string;
  container?: string;
  memory?: string;
  output?: string;
  yes?: boolean;
}

export interface ResizeRecord {
  schema: "doctor.resize/v1";
  generatedAt: string;
  target: MemoryResizeTarget;
  helper: string;
  changes: MemoryLimitChange[];
  before?: MemoryHierarchy;
  after?: MemoryHierarchy;
  approvals: ApprovalDecision[];
  result: {
    status: "preparing" | "planned" | "applying" | "succeeded" | "failed" | "cancelled";
    reason?: string;
    applyOutput?: string;
    helperDeleted: boolean;
  };
}
