import type { TenantConfigurationCapability } from "@compforge/doctor-plugin";
import { openPluginContext, type ManagedPluginContext } from "../../../plugin/context";
import {
  captureKubernetesWorkloadConfig,
  deploymentsForService,
  podsForService,
  selectServiceContainer,
} from "../../../infra/k8s/workload-config";
import type { Inspect } from "../../inspection";
import type {
  ConfigCollectConfig,
  ConfigCollectContext,
  ConfigInspectionFacts,
  ConfigServiceTargetFact,
} from "../model";

function commandReason(ok: boolean, stderr: string): string | undefined {
  return ok ? undefined : stderr.trim().split("\n")[0] || "kubectl 读取失败";
}

const DEPLOYMENT_CONFIG_SKIPPED_REASON = "用户未确认采集 Deployment Env/ConfigMap";

export function makeConfigTargetsInspect(
  config: ConfigCollectConfig,
  tenantCapability?: TenantConfigurationCapability,
): Inspect<ConfigInspectionFacts, ConfigCollectContext> {
  return {
    id: "config-targets",
    run: async (ctx) => {
      const capture = await captureKubernetesWorkloadConfig(
        ctx.executor,
        config.namespace,
        config.includeDeploymentConfig,
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
      const deploymentConfiguration: ConfigInspectionFacts["deploymentConfiguration"] = !config.includeDeploymentConfig
        ? { status: "unavailable", reason: DEPLOYMENT_CONFIG_SKIPPED_REASON }
        : deploymentReasons.length
          ? { status: "failed", reason: deploymentReasons.join("；") }
          : { status: "collected", requested: true };
      const steps = [
        ["config-services", "Service 配置目标", capture.serviceCapture, undefined],
        ["config-pods", "Pod 运行态", capture.podCapture, capture.podParseError],
        ...(capture.deploymentCapture ? [[
          "config-deployments",
          "Deployment env 配置",
          capture.deploymentCapture,
          capture.deploymentParseError,
        ] as const] : []),
        ...(capture.configMapCapture ? [[
          "config-configmaps",
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
          // Deployment 与 ConfigMap 可能包含凭据，不把 kubectl 原始输出落盘。
        });
      }
      if (!config.includeDeploymentConfig) {
        ctx.bundle.addStep({
          id: "config-deployment-environment",
          title: "Deployment Env/ConfigMap",
          risk: "observe",
          status: "skipped",
          reason: DEPLOYMENT_CONFIG_SKIPPED_REASON,
        });
      }
      const snapshot = capture.snapshot;
      if (!snapshot) {
        const reason = capture.parseError
          ?? commandReason(capture.serviceCapture.ok, capture.serviceCapture.stderr)
          ?? "读取 Kubernetes 配置失败";
        return {
          serviceTargets: { status: "failed", reason },
          deploymentConfiguration,
          tenantDatabaseTarget: { status: "failed", reason },
          tenantRequest: config.tenantId && config.tenantConfiguration
            ? {
                status: "collected",
                tenantId: config.tenantId,
                tenantName: config.tenantName,
                scopes: config.tenantConfiguration.scopes,
              }
            : { status: "unavailable", reason: "未指定 --tenant-id" },
        };
      }
      ctx.workloadConfig = snapshot;

      const services: Record<string, ConfigServiceTargetFact> = {};
      for (const serviceName of config.services) {
        const service = snapshot.services.find((item) => item.name === serviceName);
        const deployments: ConfigServiceTargetFact["deployments"] = [];
        const unavailableDeployments: ConfigServiceTargetFact["unavailableDeployments"] = [];
        if (!service) {
          if (config.includeDeploymentConfig) {
            unavailableDeployments.push({ deployment: "—", reason: "Service 不存在" });
          }
          services[serviceName] = {
            service: serviceName,
            deployments,
            unavailableDeployments,
            podRuntime: { status: "unavailable", reason: "Service 不存在" },
          };
          continue;
        }
        for (const deployment of deploymentsForService(snapshot, serviceName)) {
          const selected = selectServiceContainer(service, deployment);
          if (selected.container) {
            deployments.push({
              service: serviceName,
              deployment: deployment.name,
              container: selected.container.name,
            });
          } else {
            unavailableDeployments.push({ deployment: deployment.name, reason: selected.reason! });
          }
        }
        const podFailure = capture.podParseError
          ?? commandReason(capture.podCapture.ok, capture.podCapture.stderr);
        services[serviceName] = {
          service: serviceName,
          deployments,
          unavailableDeployments,
          podRuntime: podFailure
            ? { status: "failed", reason: podFailure }
            : {
                status: "collected",
                pods: podsForService(snapshot, serviceName).map((pod) => ({
                  pod: pod.name,
                  phase: pod.phase,
                  containers: pod.containers.map((container) => ({
                    name: container.name,
                    image: container.image,
                    requests: {
                      cpu: container.requests.cpu,
                      memory: container.requests.memory,
                    },
                    limits: {
                      cpu: container.limits.cpu,
                      memory: container.limits.memory,
                    },
                  })),
                })),
              },
        };
      }

      const tenantRequest = config.tenantId && config.tenantConfiguration
        ? {
            status: "collected" as const,
            tenantId: config.tenantId,
            tenantName: config.tenantName,
            scopes: config.tenantConfiguration.scopes,
          }
        : { status: "unavailable" as const, reason: "未指定 --tenant-id" };
      if (!config.tenantId || !config.tenantConfiguration || !tenantCapability) {
        return {
          serviceTargets: { status: "collected", services },
          deploymentConfiguration,
          tenantDatabaseTarget: { status: "unavailable", reason: "未指定 --tenant-id" },
          tenantRequest,
        };
      }

      let pluginContext: ManagedPluginContext | undefined;
      try {
        if (!ctx.tenantConfigReader) {
          pluginContext = await openPluginContext(ctx.executor, config.kube, {
            env: config.profileName,
            config: ctx.pluginConfig,
            databaseIdentity: config.fallbackIdentity,
            service: {
              name: config.tenantConfiguration.databaseService,
            },
            command: "doctor config",
            capability: tenantCapability,
            authorization: ctx.authorization,
          });
          ctx.tenantConfigReader = await tenantCapability.createReader(pluginContext);
          ctx.closeTenantAccess = () => pluginContext!.dispose();
        }
        const target = ctx.tenantConfigReader.target;
        return {
          serviceTargets: { status: "collected", services },
          deploymentConfiguration,
          tenantDatabaseTarget: {
            status: "collected",
            service: config.tenantConfiguration.databaseService,
            endpoint: target.endpoint,
            database: target.database,
            username: target.username,
            credentialSource: target.credentialSource,
          },
          tenantRequest,
        };
      } catch (error) {
        await pluginContext?.dispose();
        return {
          serviceTargets: { status: "collected", services },
          deploymentConfiguration,
          tenantDatabaseTarget: {
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          },
          tenantRequest,
        };
      }
    },
  };
}
