import type { CommandContext } from "../../command";
import { resolveKubernetesCommandContext } from "../../command";
import { KubectlExecutor, type Executor } from "../../infra/k8s/executor";
import { ServicePortForwarder } from "../../infra/k8s/service-port-forward";
import {
  EmbeddedMetricSource,
  RemoteMetricSource,
  type EmbeddedMetricTarget,
  type MetricQuerySource,
} from "../../infra/metric";
import { enforceKubernetesAccess, requireKubernetesChannel } from "../../terminal/kubernetes-access";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { MetricConfig, MetricSourceKind } from "./model";

export interface MetricSourcePreparation {
  source: MetricQuerySource;
  sourceKind: MetricSourceKind;
  embeddedSource?: EmbeddedMetricSource;
  targetCount: number;
  close(): void;
}

export async function prepareMetricSource(
  config: MetricConfig,
  plugin: PluginDefinition,
  commandContext?: CommandContext,
  injectedExecutor?: Executor,
): Promise<MetricSourcePreparation> {
  if (config.prometheus) {
    return {
      source: new RemoteMetricSource(config.prometheus),
      sourceKind: "remote",
      targetCount: config.services.length,
      close: () => {},
    };
  }

  const executor = injectedExecutor ?? new KubectlExecutor(config.kube);
  if (!injectedExecutor) {
    await requireKubernetesChannel({
      executor,
      profileName: config.profileName,
      kubeconfigSource: config.kube.kubeconfig ? "resolved" : "kubectl-default",
      namespace: config.namespace,
      commandContext,
    });
  }
  await enforceKubernetesAccess(resolveKubernetesCommandContext(executor, commandContext).access, {
    command: "doctor metric",
    needs: [{
      requirement: "required",
      rule: { verb: "list", resource: "services" },
      purpose: "解析注册了 metric capability 的 Service",
    }, {
      requirement: "required",
      rule: { verb: "list", resource: "pods" },
      purpose: "解析 Service 的 metrics endpoint",
    }, {
      requirement: "required",
      rule: { verb: "create", resource: "pods/portforward" },
      purpose: "从 Doctor Host 抓取 Service /metrics",
    }],
  });

  const forwarder = await ServicePortForwarder.create(executor, config.kube);
  try {
    const targets: EmbeddedMetricTarget[] = [];
    for (const serviceName of config.services) {
      const service = plugin.services.findWith(serviceName, "metric")!;
      const capability = service.capabilities.metric;
      const endpoints = await forwarder.forwardServiceTargets({
        host: service.name,
        port: capability.endpoint.port,
      });
      for (const endpoint of endpoints) {
        targets.push({
          url: `http://${endpoint.host}:${endpoint.port}${capability.endpoint.path}`,
          labels: {
            doctor_service: service.name,
            app_kubernetes_io_name: service.name,
            ...(endpoint.pod ? { pod: endpoint.pod } : {}),
          },
          metricNames: [...capability.metricNames],
          timeoutMs: config.intervalMs,
          maxBodyBytes: 8 * 1024 * 1024,
        });
      }
    }
    const retentionMs = config.watch.mode === "duration"
      ? config.watch.durationMs + 60_000
      : config.watch.mode === "until-interrupt" ? 60 * 60_000 : 60_000;
    const embeddedSource = new EmbeddedMetricSource({
      targets,
      retentionMs,
      sampleIntervalMs: config.intervalMs,
    });
    return {
      source: embeddedSource,
      sourceKind: "embedded",
      embeddedSource,
      targetCount: targets.length,
      close: () => forwarder.stop(),
    };
  } catch (error) {
    forwarder.stop();
    throw error;
  }
}
