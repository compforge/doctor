import { fileDataSources } from "@compforge/doctor-plugin";
import { fileConfigurationId, inspectCollectionScope } from "../model";
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
import type { KubernetesResourceCapture } from "../../../infra/k8s/resources";
import {
  deriveDeploymentName,
  parseKubernetesAutoscalers,
  parseKubernetesEvents,
  selectLifecycleEvents,
  LIFECYCLE_EVENT_LIMIT,
} from "../../../infra/k8s/workload-events";
import type { Inspect } from "../../inspection";
import { collectedFact, failedFact, unavailableFact } from "../../protocol";
import type {
  ContainerEnvironmentTarget,
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

/** 单次只读 list 的生命周期信号采集；失败只降级对应部分，不影响 Pod 运行态事实。 */
async function captureLifecycleSignals(
  ctx: InspectCommandContext,
  config: InspectConfig,
  resolved: Map<string, ResolvedKubernetesWorkload>,
): Promise<InspectFacts["lifecycleSignals"]> {
  const scope = inspectCollectionScope(config);
  if (!scope.event && !scope.hpa) return unavailableFact("inspect.lifecycle-signals", "service-targets", "所选字段未纳入 Event/HPA");
  const [events, hpas] = await Promise.all([
    scope.event ? ctx.resources({ apiVersion: "v1", resource: "events", namespace: config.namespace }) : undefined,
    scope.hpa ? ctx.resources({ apiVersion: "autoscaling/v2", resource: "horizontalpodautoscalers", namespace: config.namespace }) : undefined,
  ]);
  const recordStep = (id: string, title: string, capture: KubernetesResourceCapture | undefined) => {
    if (!capture) return;
    ctx.bundle.addStep({ id, title, risk: "observe", status: capture.value !== undefined ? "ok" : "failed",
      reason: capture.error, command: capture.execution?.command, request: capture.request,
      observedAt: capture.observedAt, durationMs: capture.durationMs });
  };
  recordStep("inspect-events", "Workload 关联 Event", events);
  recordStep("inspect-hpas", "HPA 自动扩缩", hpas);
  const failures = [
    events && events.value === undefined ? `Event：${events.error ?? "响应缺失"}` : undefined,
    hpas && hpas.value === undefined ? `HPA：${hpas.error ?? "响应缺失"}` : undefined,
  ].filter((reason): reason is string => !!reason);
  const workloads = [...resolved.values()].filter(workload => (workload.definition.namespace ?? config.namespace) === config.namespace);
  const scaleTargets = workloads.flatMap(workload => [
    ...workload.deployments.map(deployment => ({ kind: "Deployment", name: deployment.name })),
    ...workload.pods.flatMap(pod => {
      const name = deriveDeploymentName(pod.name);
      return name ? [{ kind: "Deployment", name }] : [];
    }),
    ...(workload.definition.location.kind === "resource" && ["Deployment", "StatefulSet"].includes(workload.definition.location.resource_kind)
      ? [{ kind: workload.definition.location.resource_kind, name: workload.definition.location.name }] : []),
  ]);
  const scaleTargetKeys = new Set(scaleTargets.map(target => `${target.kind}/${target.name}`));
  const objectNames = new Set(workloads.flatMap(workload => [
    ...workload.pods.map(pod => pod.name),
    ...scaleTargets.map(target => target.name),
    ...(workload.definition.location.kind === "resource" ? [workload.definition.location.name] : []),
  ]));
  let autoscalers: ReturnType<typeof parseKubernetesAutoscalers> = [];
  if (hpas?.value !== undefined) {
    try { autoscalers = parseKubernetesAutoscalers(JSON.stringify(hpas.value), config.namespace)
      .filter(hpa => scaleTargetKeys.has(`${hpa.targetKind}/${hpa.targetName}`)); }
    catch { failures.push("HPA：响应解析失败"); }
  }
  // Full Inspect can associate HPA events; event-only mode does not fetch another field's resources.
  for (const autoscaler of autoscalers) objectNames.add(autoscaler.name);
  let selectedEvents: ReturnType<typeof parseKubernetesEvents> = [];
  let omittedEvents = 0;
  if (events?.value !== undefined) {
    try {
      const selected = selectLifecycleEvents(parseKubernetesEvents(JSON.stringify(events.value), config.namespace), objectNames, Infinity, config.timeWindow);
      omittedEvents = Math.max(0, selected.length - LIFECYCLE_EVENT_LIMIT);
      selectedEvents = selected.slice(-LIFECYCLE_EVENT_LIMIT);
    } catch { failures.push("Event：响应解析失败"); }
  }
  if (failures.length) {
    ctx.log(`[collect] Event/HPA 采集缺口：${failures.join("；")}`);
    if (config.field || failures.length === Number(scope.event) + Number(scope.hpa)) {
      return failedFact("inspect.lifecycle-signals", "service-targets", failures.join("；"));
    }
  }
  return collectedFact("inspect.lifecycle-signals", "service-targets", { events: selectedEvents, autoscalers,
    eventsObservedAt: events?.observedAt, timeWindow: config.timeWindow, omittedEvents });
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

/** @spec Env is observed inside each business container; declaration values never substitute for it. */
export function containerEnvironmentTargets(facts: InspectFacts): {
  targets: ContainerEnvironmentTarget[]; missing: string[];
} {
  const targets: ContainerEnvironmentTarget[] = [];
  const missing: string[] = [];
  if (facts.serviceTargets.status !== "collected") return { targets, missing: [facts.serviceTargets.reason] };
  for (const service of Object.values(facts.serviceTargets.services)) {
    for (const workload of Object.values(service.workloads)) {
      if (workload.podRuntime.status !== "collected") {
        missing.push(`${service.service}/${workload.name}: ${workload.podRuntime.reason}`);
        continue;
      }
      if (!workload.podRuntime.pods.length) missing.push(`${service.service}/${workload.name}: 没有 Pod 可读取 Env`);
      for (const pod of workload.podRuntime.pods) {
        const source = `${service.service}/${workload.name}/${pod.pod}`;
        if (!pod.environmentContainer) {
          missing.push(`${source}: ${pod.environmentUnavailableReason ?? "未定位到业务 Container"}`);
        } else if (pod.phase !== "Running") {
          missing.push(`${source}/${pod.environmentContainer}: Pod 状态为 ${pod.phase}，无法读取 Env`);
        } else {
          targets.push({ service: service.service, workload: workload.name, pod: pod.pod, container: pod.environmentContainer });
        }
      }
    }
  }
  return { targets, missing };
}

export function makeServiceTargetsInspect(
  config: InspectConfig,
  catalog: ServiceCatalog,
): Inspect<InspectFacts, InspectCommandContext> {
  const scope = inspectCollectionScope(config);
  return {
    id: "service-targets",
    run: async (ctx) => {
      const capture = await captureKubernetesWorkloadConfig(
        ctx.resources,
        config.namespace,
        scope.deployment,
        config.services.some((name) => catalog.find(name)?.workloads.some(
          (workload) => workload.location.kind === "service",
        )),
      );
      const deploymentReasons = scope.deployment ? [
        capture.deploymentParseError
        ?? (capture.deploymentCapture
          ? capture.deploymentCapture.error
          : "Deployment 未读取"),
        capture.configMapParseError
        ?? (capture.configMapCapture
          ? capture.configMapCapture.error
          : "ConfigMap 未读取"),
      ].filter((reason): reason is string => !!reason) : [];
      const deploymentConfiguration: InspectFacts["deploymentConfiguration"] = !scope.deployment
        ? unavailableFact("inspect.deployment-configuration", "service-targets", DEPLOYMENT_CONFIG_SKIPPED_REASON)
        : deploymentReasons.length
          ? failedFact("inspect.deployment-configuration", "service-targets", deploymentReasons.join("；"))
          : collectedFact("inspect.deployment-configuration", "service-targets", { requested: true });
      const dependencyTargetsFailure = capture.podParseError
        ?? capture.podCapture.error;
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
          status: !result.error && !parseError ? "ok" : "failed",
          reason: parseError ?? result.error,
          command: result.execution?.command,
          request: result.request,
          reused: result.reused, observedAt: result.observedAt,
          durationMs: result.durationMs,
          // Pod spec、Deployment 与 ConfigMap 都可能包含凭据，只落解析后的脱敏 Fact。
        });
      }
      const snapshot = capture.snapshot;
      if (!snapshot) {
        const reason = capture.parseError
          ?? (capture.serviceCapture
            ? capture.serviceCapture.error
            : undefined)
          ?? "读取 Kubernetes 配置失败";
        return {
          serviceTargets: failedFact("inspect.service-targets", "service-targets", reason),
          deploymentConfiguration,
          dependencyTargets: scope.dependencies
            ? failedFact("inspect.dependency-targets", "service-targets", reason)
            : unavailableFact("inspect.dependency-targets", "service-targets", DEPENDENCIES_SKIPPED_REASON),
          lifecycleSignals: unavailableFact("inspect.lifecycle-signals", "service-targets", "Workload 快照未取得，未采集事件与 Autoscaler"),
        };
      }
      ctx.workloadConfig = snapshot;
      const resolvedWorkloads = new Map<string, ResolvedKubernetesWorkload>();
      const { environment } = await ctx.command.environment(ctx.executor);
      for (const serviceName of config.services) {
        for (const definition of catalog.find(serviceName)!.workloads) {
          let captureIndex = 0;
          resolvedWorkloads.set(JSON.stringify([serviceName, definition.name]), await resolveKubernetesWorkload(
            snapshot, definition, ctx.resources, config.namespace, environment.name,
            (result) => ctx.bundle.addStep({
              id: `inspect-workload-${serviceName}-${definition.name}-${++captureIndex}`,
              title: `${serviceName}/${definition.name} Workload 定位`,
              risk: "observe", status: !result.error ? "ok" : "failed",
              reason: result.error,
              command: result.execution?.command,
              request: result.request,
              reused: result.reused, observedAt: result.observedAt, durationMs: result.durationMs,
            }),
          ));
        }
      }
      const resolvedDependencyTargets: InspectFacts["dependencyTargets"] = !scope.dependencies
        ? unavailableFact("inspect.dependency-targets", "service-targets", DEPENDENCIES_SKIPPED_REASON)
        : dependencyTargetsFailure
          ? failedFact("inspect.dependency-targets", "service-targets", dependencyTargetsFailure)
          : dependencyTargets(config, resolvedWorkloads, catalog);
      const lifecycleSignals = await captureLifecycleSignals(ctx, config, resolvedWorkloads);

      const services: Record<string, InspectServiceTargetFact> = {};
      for (const serviceName of config.services) {
        const declaredService = catalog.find(serviceName)!;
        const workloads: InspectServiceTargetFact["workloads"] = {};
        for (const definition of declaredService.workloads) {
          const resolved = resolvedWorkloads.get(JSON.stringify([serviceName, definition.name]))!;
          const deployments = [] as typeof workloads[string]["deployments"];
          const unavailableDeployments = [] as typeof workloads[string]["unavailableDeployments"];
          if (scope.deployment) {
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
            ?? capture.podCapture.error;
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
                  pods: resolved.pods.map((pod) => {
                    const environment = (config.field === "env" || config.field === "config") ? selectWorkloadPodContainer(resolved, pod) : undefined;
                    return {
                      instance: resolved.instances.find(instance => instance.pod === pod.name)!,
                      pod: pod.name,
                      serviceAccountName: pod.serviceAccountName,
                      ...((config.field === "env" || config.field === "config") ? {
                        environmentContainer: environment?.container?.name,
                        environmentUnavailableReason: environment?.reason,
                      } : {}),
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
                    };
                  }),
                }),
          };
        }
        services[serviceName] = {
          service: serviceName,
          toolchain: declaredService.toolchain,
          files: scope.files ? fileDataSources(declaredService).flatMap(source => source.paths.map(path => ({
            id: fileConfigurationId(serviceName, source.clientKey, path), path, workload: source.workload,
          }))) : undefined,
          workloads,
        };
      }
      return {
        serviceTargets: collectedFact("inspect.service-targets", "service-targets", { services }),
        deploymentConfiguration,
        dependencyTargets: resolvedDependencyTargets,
        lifecycleSignals,
      };
    },
  };
}
