import { workloadProbeProviders } from "../../../plugin/workload-extensions";
import type {
  ServiceCatalog,
  Toolchain,
} from "@compforge/doctor-plugin";
import {
  captureKubernetesWorkloadConfig,
  resolveKubernetesWorkload,
  selectWorkloadDeploymentContainer,
  selectWorkloadPodContainer,
} from "../../../infra/k8s/workload-config";
import type { ResolvedKubernetesWorkload } from "../../../infra/k8s/workload-config";
import type {
  KubernetesContainerState,
  KubernetesContainerTermination,
} from "@compforge/harness-toolbox/kubernetes/pod";
import type { Inspect } from "../../inspection";
import { collectedFact, failedFact, unavailableFact } from "../../protocol";
import type {
  InspectCommandContext,
  InspectConfig,
  InspectContainerTerminationFact,
  InspectFacts,
  InspectPodContainerFact,
  InspectServiceTargetFact,
} from "../model";

function commandReason(ok: boolean, stderr: string): string | undefined {
  return ok ? undefined : stderr.trim().split("\n")[0] || "kubectl 读取失败";
}

const DEPLOYMENT_CONFIG_SKIPPED_REASON = "Deployment Env/ConfigMap 未纳入本次采集范围";
const DEPENDENCIES_SKIPPED_REASON = "应用依赖未纳入本次采集范围";

function sameToolchain(left: Toolchain, right: Toolchain): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function terminationFact(termination: KubernetesContainerTermination): InspectContainerTerminationFact {
  return {
    exitCode: termination.exitCode,
    signal: termination.signal,
    reason: termination.reason,
    message: termination.message,
    startedAt: termination.startedAt,
    finishedAt: termination.finishedAt,
  };
}

export function inspectContainerStateFact(
  state: KubernetesContainerState | undefined,
): InspectPodContainerFact["state"] {
  if (!state) return undefined;
  if (state.kind === "waiting") {
    return { kind: state.kind, reason: state.reason, message: state.message };
  }
  if (state.kind === "running") return { kind: state.kind, startedAt: state.startedAt };
  return { kind: state.kind, ...terminationFact(state) };
}

function dependencyTargets(
  config: InspectConfig,
  resolved: Map<string, ResolvedKubernetesWorkload>,
  catalog: ServiceCatalog,
): Extract<InspectFacts["dependencyTargets"], { status: "collected" }> {
  const targets: Extract<InspectFacts["dependencyTargets"], { status: "collected" }>["targets"] = [];
  const missing: string[] = [];
  for (const serviceName of config.services) {
    const service = catalog.find(serviceName);
    const declared = service?.toolchain;
    if (!declared) {
      missing.push(`${serviceName}: Plugin 未声明 Toolchain`);
      continue;
    }
    let selectedCount = 0;
    for (const definition of service?.workloads ?? []) {
      const workload = resolved.get(JSON.stringify([serviceName, definition.name]))!;
      const pods = workload.pods.filter((pod) => pod.phase === "Running");
      if (!pods.length) {
        missing.push(`${serviceName}/${definition.name}: ${workload.unavailableReason ?? "没有 Running Pod"}`);
        continue;
      }
      for (const pod of pods) {
        const selected = selectWorkloadPodContainer(workload, pod);
        if (!selected.container) {
          missing.push(`${serviceName}/${definition.name}/${pod.name}: ${selected.reason}`);
          continue;
        }
        selectedCount += 1;
        const imageKey = selected.container.imageId || selected.container.image
          || `${pod.name}/${selected.container.name}`;
        const existing = targets.find((target) => (target.imageId || target.image) === imageKey);
        if (existing) {
          if (!sameToolchain(existing.toolchain, declared)) {
            missing.push(
              `${serviceName}: image '${imageKey}' 的 Toolchain 声明与 ${existing.services.join(", ")} 不一致`,
            );
          } else if (!existing.services.includes(serviceName)) {
            existing.services.push(serviceName);
          }
          continue;
        }
        targets.push({
          id: `inspect-dependencies-${targets.length + 1}`,
          services: [serviceName],
          pod: pod.name,
          container: selected.container.name,
          image: selected.container.image,
          imageId: selected.container.imageId,
          toolchain: declared,
        });
      }
    }
    if (!selectedCount) missing.push(`${serviceName}: 未定位到可采集依赖的业务 Container`);
  }
  return collectedFact("inspect.dependency-targets", "service-targets", { targets, missing });
}

export function makeServiceTargetsInspect(
  config: InspectConfig,
  catalog: ServiceCatalog,
): Inspect<InspectFacts, InspectCommandContext> {
  return {
    id: "service-targets",
    run: async (ctx) => {
      const capture = await captureKubernetesWorkloadConfig(
        ctx.executor,
        config.namespace,
        config.includeDeploymentConfig === true,
        config.services.some((name) => catalog.find(name)?.workloads.some(
          (workload) => workload.location.kind === "service",
        )),
      );
      const deploymentReasons = config.includeDeploymentConfig ? [
        capture.deploymentParseError
        ?? (capture.deploymentCapture
          ? commandReason(capture.deploymentCapture.ok, capture.deploymentCapture.stderr)
          : "Deployment 未读取"),
        capture.configMapParseError
        ?? (capture.configMapCapture
          ? commandReason(capture.configMapCapture.ok, capture.configMapCapture.stderr)
          : "ConfigMap 未读取"),
      ].filter((reason): reason is string => !!reason) : [];
      const deploymentConfiguration: InspectFacts["deploymentConfiguration"] = !config.includeDeploymentConfig
        ? unavailableFact("inspect.deployment-configuration", "service-targets", DEPLOYMENT_CONFIG_SKIPPED_REASON)
        : deploymentReasons.length
          ? failedFact("inspect.deployment-configuration", "service-targets", deploymentReasons.join("；"))
          : collectedFact("inspect.deployment-configuration", "service-targets", { requested: true });
      const dependencyTargetsFailure = capture.podParseError
        ?? commandReason(capture.podCapture.ok, capture.podCapture.stderr);
      const steps = [
        ...(capture.serviceCapture ? [["inspect-services", "Workload Service 资源", capture.serviceCapture, undefined] as const] : []),
        ["inspect-pods", "Pod 运行态", capture.podCapture, capture.podParseError],
        ...(capture.deploymentCapture ? [[
          "inspect-deployments",
          "Deployment env 配置",
          capture.deploymentCapture,
          capture.deploymentParseError,
        ] as const] : []),
        ...(capture.configMapCapture ? [[
          "inspect-configmaps",
          "ConfigMap 配置",
          capture.configMapCapture,
          capture.configMapParseError,
        ] as const] : []),
      ] as const;
      for (const [id, title, result, parseError] of steps) {
        ctx.bundle.addStep({
          id,
          title,
          risk: "observe",
          status: result.ok && !parseError ? "ok" : "failed",
          reason: parseError ?? commandReason(result.ok, result.stderr),
          command: result.command,
          durationMs: result.durationMs,
          // Pod spec、Deployment 与 ConfigMap 都可能包含凭据，只落解析后的脱敏 Fact。
        });
      }
      const snapshot = capture.snapshot;
      if (!snapshot) {
        const reason = capture.parseError
          ?? (capture.serviceCapture
            ? commandReason(capture.serviceCapture.ok, capture.serviceCapture.stderr)
            : undefined)
          ?? "读取 Kubernetes 配置失败";
        return {
          serviceTargets: failedFact("inspect.service-targets", "service-targets", reason),
          deploymentConfiguration,
          dependencyTargets: config.includeDependencies
            ? failedFact("inspect.dependency-targets", "service-targets", reason)
            : unavailableFact("inspect.dependency-targets", "service-targets", DEPENDENCIES_SKIPPED_REASON),
        };
      }
      ctx.workloadConfig = snapshot;
      const resolvedWorkloads = new Map<string, ResolvedKubernetesWorkload>();
      const { environment } = await ctx.command.environment(ctx.executor);
      for (const serviceName of config.services) {
        for (const definition of catalog.find(serviceName)!.workloads) {
          let captureIndex = 0;
          resolvedWorkloads.set(JSON.stringify([serviceName, definition.name]), await resolveKubernetesWorkload(
            snapshot, definition, ctx.executor, config.namespace, environment.name,
            (result) => ctx.bundle.addStep({
              id: `inspect-workload-${serviceName}-${definition.name}-${++captureIndex}`,
              title: `${serviceName}/${definition.name} Workload 定位`,
              risk: "observe", status: result.ok ? "ok" : "failed",
              reason: commandReason(result.ok, result.stderr),
              command: result.command, durationMs: result.durationMs,
            }),
          ));
        }
      }
      const resolvedDependencyTargets: InspectFacts["dependencyTargets"] = !config.includeDependencies
        ? unavailableFact("inspect.dependency-targets", "service-targets", DEPENDENCIES_SKIPPED_REASON)
        : dependencyTargetsFailure
          ? failedFact("inspect.dependency-targets", "service-targets", dependencyTargetsFailure)
          : dependencyTargets(config, resolvedWorkloads, catalog);

      const services: Record<string, InspectServiceTargetFact> = {};
      for (const serviceName of config.services) {
        const declaredService = catalog.find(serviceName)!;
        const configurationSupported = !!catalog.find(serviceName)?.configurationInspection;
        const workloads: InspectServiceTargetFact["workloads"] = {};
        for (const definition of declaredService.workloads) {
          const resolved = resolvedWorkloads.get(JSON.stringify([serviceName, definition.name]))!;
          const deployments = [] as typeof workloads[string]["deployments"];
          const unavailableDeployments = [] as typeof workloads[string]["unavailableDeployments"];
          if (configurationSupported) {
            for (const deployment of resolved.deployments) {
              const selected = selectWorkloadDeploymentContainer(resolved, deployment);
              if (selected.container) {
                deployments.push({
                  service: serviceName,
                  workload: definition.name,
                  deployment: deployment.name,
                  container: selected.container.name,
                });
              } else {
                unavailableDeployments.push({ deployment: deployment.name, reason: selected.reason! });
              }
            }
          }
          const podFailure = capture.podParseError
            ?? commandReason(capture.podCapture.ok, capture.podCapture.stderr);
          workloads[definition.name] = {
            name: definition.name,
            description: definition.description,
            location: definition.location,
            probes: workloadProbeProviders(catalog, serviceName)
              .filter(({ extension }) => extension.workload === definition.name)
              .map(({ extension }) => extension.id),
            deployments,
            unavailableDeployments,
            podRuntime: podFailure
              ? failedFact("inspect.workload-pods", "service-targets", podFailure)
              : resolved.unavailableReason
                ? unavailableFact("inspect.workload-pods", "service-targets", resolved.unavailableReason)
                : collectedFact("inspect.workload-pods", "service-targets", {
                  pods: resolved.pods.map((pod) => ({
                    instance: resolved.instances.find(instance => instance.pod === pod.name)!,
                    pod: pod.name,
                    serviceAccountName: pod.serviceAccountName,
                    phase: pod.phase,
                    reason: pod.reason,
                    message: pod.message,
                    conditions: pod.conditions.map((condition) => ({ ...condition })),
                    containers: pod.containers.map((container) => ({
                      name: container.name,
                      image: container.image,
                      imageId: container.imageId,
                      requests: { cpu: container.requests.cpu, memory: container.requests.memory },
                      limits: { cpu: container.limits.cpu, memory: container.limits.memory },
                      ready: container.ready,
                      restartCount: container.restartCount,
                      state: inspectContainerStateFact(container.state),
                      lastTermination: container.lastTermination
                        ? terminationFact(container.lastTermination)
                        : undefined,
                    })),
                  })),
                }),
          };
        }
        services[serviceName] = {
          service: serviceName,
          toolchain: declaredService.toolchain,
          configurationSupported,
          workloads,
        };
      }
      return {
        serviceTargets: collectedFact("inspect.service-targets", "service-targets", { services }),
        deploymentConfiguration,
        dependencyTargets: resolvedDependencyTargets,
      };
    },
  };
}
