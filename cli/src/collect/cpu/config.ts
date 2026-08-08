import { terminalStdout } from "../../terminal/output";
import type { Executor } from "../../infra/k8s/executor";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
  resolvePodTarget,
  type KubernetesCommandConfig,
  type KubernetesCommandInput,
  type PodTarget,
} from "../../command/kubernetes-target";
import { resolveKubernetesCommandContext } from "../../command";
import type { CommandContext } from "../../command";
import { parseInspectionMode, type InspectionMode } from "../inspection";
import { printModeChoices, promptMode } from "../mode-selection";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";

export interface CpuConfig {
  collect: KubernetesCommandConfig;
  target: PodTarget;
  pidFlag?: string;
  mode: InspectionMode;
  output?: string;
}

export interface CpuConfigInput extends KubernetesCommandInput {
  pod?: string;
  container?: string;
  pid?: string;
  mode?: string;
  output?: string;
}

export async function resolveCpuConfig(
  input: CpuConfigInput,
  commandContext?: CommandContext,
): Promise<{ config: CpuConfig; executor: Executor } | undefined> {
  let mode = input.mode?.trim() ? parseInspectionMode(input.mode) : undefined;
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!mode && !interactive) {
    throw new Error("当前为非交互终端；请显式指定 --mode observe、overhead 或 disrupt");
  }
  // namespace / Pod 是 collect 共用上下文，交互时先于 CPU 领域的 mode 出场。
  const collect = await resolveKubernetesCommandConfig(
    input,
    undefined,
    commandContext,
  );
  if (!collect) return undefined;
  terminalStdout.write(
    `[collect] namespace: ${collect.kubernetes.namespace}（${collect.kubernetes.namespaceSource}）\n`,
  );
  const executor = createKubernetesExecutor(collect);
  const access = resolveKubernetesCommandContext(executor, commandContext).access;
  await enforceKubernetesAccess(access, {
    command: "doctor cpu",
    needs: [{
      requirement: "required",
      rule: { verb: "create", resource: "pods/exec" },
      purpose: "读取 /proc 并运行 Python CPU 探针",
    }, {
      requirement: "preferred",
      rule: { verb: "get", resource: "pods.metrics.k8s.io" },
      purpose: "采集 Container CPU/内存使用 Fact",
      fallback: "权限缺失时继续执行，报告中缺少资源使用 Fact",
    }],
  });
  const target = await resolvePodTarget({
    config: collect,
    executor,
    pod: input.pod,
    container: input.container,
    selectContainer: true,
    access,
    selection: {
      candidateRole: "目标",
      purpose: "采集 CPU 诊断数据",
    },
  });
  if (!target) return undefined;
  if (!mode) {
    printModeChoices();
    mode = await promptMode();
    if (!mode) return undefined;
  }
  return {
    config: { collect, target, pidFlag: input.pid, mode, output: input.output },
    executor,
  };
}
