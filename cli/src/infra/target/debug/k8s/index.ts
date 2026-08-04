import type { ExecResult, Executor, ExecTarget } from "../../../k8s/executor";
import {
  buildEphemeralContainerMutation,
  parseEphemeralContainers,
  waitForEphemeralContainerRunning,
} from "../../../k8s/ephemeral-container";
import { executeK8sMutation, inspectK8sMutation } from "../../../k8s/mutation";
import {
  DOCTOR_DEBUG_CONTAINER_PREFIX,
  DOCTOR_DEBUG_MANIFEST,
  type DebugCapability,
  type DebugEngine,
  type DebugEnvironmentFact,
  type DebugEnvironmentFacts,
  type DebugEnvironmentResolution,
  type DebugPreparation,
  type DebugPreparationOptions,
} from "../model";
import {
  inspectDebugGdb,
  resolveTargetImageKeepalive,
} from "./tooling";

function inspectDebugEnvironments(
  podJson: string,
  targetContainer: string,
): DebugEnvironmentFact[] {
  return parseEphemeralContainers(podJson, targetContainer)
    .filter((item) =>
      item.name.startsWith(DOCTOR_DEBUG_CONTAINER_PREFIX)
      || /(^|\/)doctor-debug(?::|@|$)/.test(item.image)
    )
    .map((item) => {
      const hasDiagnosticCapability = item.capabilities.some(
        (capability) => capability === "SYS_PTRACE" || capability === "NET_RAW",
      );
      const compatible = item.state === "running" && hasDiagnosticCapability;
      return {
        kind: "ephemeral-container" as const,
        executionContainer: item.name,
        image: item.image,
        targetContainer: item.targetContainer,
        state: item.state,
        capabilities: item.capabilities,
        compatible,
        reason: compatible
          ? undefined
          : item.state !== "running"
            ? `container state=${item.state}`
            : "未声明 SYS_PTRACE 或 NET_RAW capability",
      };
    });
}

function resolveDebugEnvironment(
  facts: readonly DebugEnvironmentFact[],
  requiredCapabilities: readonly DebugCapability[] = ["SYS_PTRACE"],
): DebugEnvironmentResolution {
  const usable = facts.filter((fact) =>
    fact.compatible
    && requiredCapabilities.every((capability) => fact.capabilities.includes(capability))
  );
  if (usable.length === 0) {
    return {
      ok: false,
      reason: "目标 Pod 中没有已就绪且具备 "
        + `${requiredCapabilities.join("、")} 的 doctor debug 临时容器；请先执行 doctor debug`,
    };
  }
  // Ephemeral containers cannot be replaced; later list entries are newer deploy attempts.
  // Prefer the newest compatible one so callers never need a manual container-name override.
  return { ok: true, value: usable.at(-1)! };
}

function inspectDebug(
  podJson: string,
  targetContainer: string,
): DebugEnvironmentFacts {
  const environments = inspectDebugEnvironments(podJson, targetContainer);
  const resolved = resolveDebugEnvironment(environments);
  return resolved.ok
    ? { environments, selected: resolved.value }
    : { environments, reason: resolved.reason };
}

function inspectDebugContainerReadiness(
  exec: Executor,
  pod: string,
  container: string,
): Promise<ExecResult> {
  const target: ExecTarget = { pod, container };
  const command = ["sh", "-c", `test -r ${DOCTOR_DEBUG_MANIFEST} && cat ${DOCTOR_DEBUG_MANIFEST}`];
  return exec.exec(target, command, { timeoutMs: 20_000 });
}

function planDebugPreparation(
  exec: Executor,
  options: DebugPreparationOptions,
): DebugPreparation {
  // The capability owns the Doctor-specific security shape; k8s/ only owns generic mutation mechanics.
  const { environmentName, ...deployment } = options;
  const mutation = buildEphemeralContainerMutation({
    ...deployment,
    containerName: environmentName,
    capabilities: options.capabilities,
    runAsUser: 0,
  });
  return {
    route: "ephemeral-container",
    async preflight() {
      const result = await inspectK8sMutation(exec, mutation);
      return { runnable: result.fact.runnable, reason: result.fact.reason };
    },
    execute: () => executeK8sMutation(exec, mutation),
    waitUntilReady: () => waitForEphemeralContainerRunning(
      exec,
      options.podName,
      environmentName,
      options.timeoutMs,
    ),
  };
}

export const kubernetesDebugEngine: DebugEngine = {
  inspectEnvironments: inspectDebugEnvironments,
  resolveEnvironment: resolveDebugEnvironment,
  inspect: inspectDebug,
  inspectReadiness: inspectDebugContainerReadiness,
  resolveTargetImageKeepalive,
  inspectGdb: inspectDebugGdb,
  planPreparation: planDebugPreparation,
};
