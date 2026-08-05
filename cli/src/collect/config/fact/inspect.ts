import type { TenantConfigurationCapability } from "@compforge/doctor-plugin";
import { createPluginContext } from "../../../plugin/context";
import {
  captureKubernetesWorkloadConfig,
  deploymentsForService,
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

export function makeConfigTargetsInspect(
  config: ConfigCollectConfig,
  tenantCapability?: TenantConfigurationCapability,
): Inspect<ConfigInspectionFacts, ConfigCollectContext> {
  return {
    id: "config-targets",
    run: async (ctx) => {
      const capture = await captureKubernetesWorkloadConfig(ctx.executor, config.namespace);
      for (const [id, title, result] of [
        ["config-services", "Service 配置目标", capture.serviceCapture],
        ["config-deployments", "Deployment env 配置", capture.deploymentCapture],
        ["config-configmaps", "ConfigMap 配置", capture.configMapCapture],
      ] as const) {
        ctx.bundle.addStep({
          id,
          title,
          risk: "observe",
          status: result.ok ? "ok" : "failed",
          reason: commandReason(result.ok, result.stderr),
          command: result.command,
          durationMs: result.durationMs,
          // Deployment 与 ConfigMap 可能包含凭据，不把 kubectl 原始输出落盘。
        });
      }
      const snapshot = capture.snapshot;
      if (!snapshot) {
        const reason = capture.parseError
          ?? commandReason(capture.serviceCapture.ok, capture.serviceCapture.stderr)
          ?? commandReason(capture.deploymentCapture.ok, capture.deploymentCapture.stderr)
          ?? commandReason(capture.configMapCapture.ok, capture.configMapCapture.stderr)
          ?? "读取 Kubernetes 配置失败";
        return {
          serviceTargets: { status: "failed", reason },
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
          services[serviceName] = {
            service: serviceName,
            deployments,
            unavailableDeployments: [{ deployment: "—", reason: "Service 不存在" }],
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
        services[serviceName] = { service: serviceName, deployments, unavailableDeployments };
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
          tenantDatabaseTarget: { status: "unavailable", reason: "未指定 --tenant-id" },
          tenantRequest,
        };
      }

      let pluginContext: ReturnType<typeof createPluginContext> | undefined;
      try {
        if (!ctx.tenantConfigReader) {
          pluginContext = createPluginContext(ctx.executor, config.kube, {
            profileName: config.profileName,
            databaseIdentity: config.fallbackIdentity,
            service: {
              name: config.tenantConfiguration.databaseService,
            },
          });
          ctx.tenantConfigReader = await tenantCapability.createReader(pluginContext);
          ctx.closeTenantAccess = () => pluginContext!.dispose();
        }
        const target = ctx.tenantConfigReader.target;
        return {
          serviceTargets: { status: "collected", services },
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
