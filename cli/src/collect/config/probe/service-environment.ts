import type { Probe } from "../../protocol";
import { PROBE_RUNNABLE, probeUnavailable } from "../../protocol";
import { resolveContainerEnvironment } from "../../../infra/k8s/workload-config";
import type {
  ConfigCollectConfig,
  ConfigCollectContext,
  ConfigDeploymentTarget,
  ConfigInspectionFacts,
  ConfigObservation,
  EnvironmentConfigObservation,
} from "../model";

function targetFromFacts(
  facts: ConfigInspectionFacts,
  target: ConfigDeploymentTarget,
): ConfigDeploymentTarget | undefined {
  if (facts.serviceTargets.status !== "collected") return undefined;
  return facts.serviceTargets.services[target.service]?.deployments.find(
    (item) => item.deployment === target.deployment && item.container === target.container,
  );
}

export function makeServiceConfigProbe(
  target: ConfigDeploymentTarget,
): Probe<ConfigObservation, ConfigInspectionFacts, ConfigCollectConfig, ConfigCollectContext> {
  const id = `config-environment-${target.service}-${target.deployment}`;
  return {
    id,
    evaluate: (facts) => targetFromFacts(facts, target)
      ? PROBE_RUNNABLE
      : probeUnavailable(`${target.service}/${target.deployment} 不在 Inspect 确认的采集目标中`),
    onUnavailable: (ctx, reason) => ctx.bundle.addStep({
      id,
      title: `${target.service}/${target.deployment} Env 配置`,
      risk: "observe",
      status: "unavailable",
      reason,
    }),
    run: async (ctx) => {
      const snapshot = ctx.workloadConfig;
      const deployment = snapshot?.deployments.find((item) => item.name === target.deployment);
      const container = deployment?.containers.find((item) => item.name === target.container);
      if (!snapshot || !container) throw new Error(`无法读取 ${target.deployment}/${target.container} 配置`);
      const resolved = resolveContainerEnvironment(container, snapshot.configMaps);
      const observation: EnvironmentConfigObservation = {
        id,
        kind: "environment-config",
        service: target.service,
        deployment: target.deployment,
        container: target.container,
        values: resolved.values,
      };
      ctx.bundle.addStep({
        id,
        title: `${target.service}/${target.deployment} Env 配置`,
        risk: "observe",
        status: resolved.missing.length ? "unavailable" : "ok",
        reason: resolved.missing.length ? resolved.missing.join("；") : undefined,
        output: JSON.stringify(observation, null, 2),
        ext: "json",
      });
      return [observation];
    },
  };
}
