import { terminalStdout } from "../../terminal/output";
import {
  createPodHttpEndpointInspector,
  createPodHttpSender,
  supportsPodCurlDiagnostics,
} from "../../infra/http/pod";
import type { Executor } from "../../infra/k8s/executor";
import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
  resolvePodTarget,
  type KubernetesCommandInput,
} from "../../command/kubernetes-target";
import { resolveKubernetesCommandContext } from "../../command";
import type { CommandContext } from "../../command";
import { failReason } from "../../infra/k8s/result";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import type { HttpExecutionTarget } from "../shared/http/model";

export interface PodHttpExecutionInput extends KubernetesCommandInput {
  pod?: string;
  container?: string;
  interactive?: boolean;
}

export async function resolvePodHttpExecution(
  input: PodHttpExecutionInput,
  injectedExecutor?: Executor,
  commandContext?: CommandContext,
) {
  const collect = await resolveKubernetesCommandConfig(
    input,
    injectedExecutor,
    commandContext,
  );
  if (!collect) return undefined;
  terminalStdout.write(
    `[collect] namespace: ${collect.kubernetes.namespace}（${collect.kubernetes.namespaceSource}）\n`,
  );
  const executor = injectedExecutor ?? createKubernetesExecutor(collect);
  const access = resolveKubernetesCommandContext(executor, commandContext).access;
  await enforceKubernetesAccess(access, {
    command: "doctor http --execution pod",
    needs: [{
      requirement: "required",
      rule: { verb: "create", resource: "pods/exec" },
      purpose: "在目标 Container 内执行 curl",
    }],
  });
  const selected = await resolvePodTarget({
    config: collect,
    executor,
    pod: input.pod,
    container: input.container,
    selectContainer: true,
    interactive: input.interactive,
    access,
    selection: {
      role: "diagnostic-target",
      purpose: "执行 HTTP 场景请求",
    },
  });
  if (!selected) return undefined;

  const curl = await executor.exec(selected, ["curl", "--version"], { timeoutMs: 10_000 });
  if (!curl.ok) {
    throw new Error(
      `pod/${selected.pod} container/${selected.container} 无法执行 curl：${failReason(curl)}`,
    );
  }

  const target: HttpExecutionTarget = {
    kind: "pod",
    namespace: collect.kubernetes.namespace,
    pod: selected.pod,
    container: selected.container!,
  };
  terminalStdout.write(
    `[http] 请求执行位置：pod（namespace=${target.namespace}, pod=${target.pod}, container=${target.container}）\n`,
  );
  return {
    collect,
    executor,
    target,
    sendHttp: createPodHttpSender(executor, selected, supportsPodCurlDiagnostics(curl.stdout)),
    inspectEndpoint: createPodHttpEndpointInspector(executor, selected),
  };
}
