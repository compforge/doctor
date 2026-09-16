import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { KubectlPodLogAccess } from "@compforge/harness-toolbox/kubernetes/pod-log";
import type { CommandContext } from "../command";
import { parsePodChoices, promptPod } from "../infra/k8s/pod-selection";
import { terminalStdout } from "../terminal/output";
import { resolveUserSelection, selectionCandidateLabel, type SelectionContext } from "../terminal/selection-context";

export async function resolveDataSourcePod(input: {
  service: string;
  pod?: string;
  executor: Executor;
  namespace: string;
  interactive: boolean;
  commandContext: CommandContext;
  selection: SelectionContext;
}): Promise<string | undefined> {
  const access = new KubectlPodLogAccess(input.executor, input.namespace);
  const listed = await access.listServicePods([input.service]);
  if (!listed.serviceCapture.ok || !listed.podCapture.ok || listed.parseError) {
    const reason = listed.parseError
      ?? (!listed.serviceCapture.ok ? listed.serviceCapture.stderr : listed.podCapture.stderr).trim();
    throw new Error(`读取 Service/Pod 候选失败：${reason || "unknown error"}`);
  }
  const names = listed.byService[input.service] ?? [];
  const choices = parsePodChoices(listed.podCapture.stdout).filter((pod) => names.includes(pod.name));
  const explicit = input.pod?.trim();
  if (explicit) {
    if (!names.includes(explicit)) throw new Error(`Service '${input.service}' 的 Running Pod 中不存在 '${explicit}'`);
    return explicit;
  }
  if (!choices.length) throw new Error(`Service '${input.service}' 没有 Running Pod`);
  if (choices.length === 1) {
    terminalStdout.write(
      `[collect] ${selectionCandidateLabel(input.selection, "Pod")}: ${choices[0]!.name}`
      + "（唯一 Running Pod，自动选择）\n",
    );
    return choices[0]!.name;
  }
  if (!input.interactive) throw new Error(`Service '${input.service}' 有多个 Running Pod；请用 --pod <pod> 指定`);
  const selectPod = () => promptPod(choices, { selection: input.selection });
  return resolveUserSelection(
    input.commandContext,
    input.selection,
    "Pod",
    [input.namespace],
    selectPod,
  );
}
