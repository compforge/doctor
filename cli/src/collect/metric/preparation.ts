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
import {
  prepareStoreMetricCollection,
  selectedMetricStoreKinds,
  type StoreMetricCollection,
} from "./store/collector";

export interface MetricSourcePreparation {
  source: MetricQuerySource;
  storeSource?: MetricQuerySource;
  sourceKind: MetricSourceKind;
  embeddedSource?: EmbeddedMetricSource;
  collectSupplement?: (source: EmbeddedMetricSource) => Promise<string[]>;
  targetCount: number;
  exporterStoreTargets: number;
  directStoreTargets: number;
  close(): Promise<void> | void;
}

export async function prepareMetricSource(
  config: MetricConfig,
  plugin: PluginDefinition,
  commandContext?: CommandContext,
  injectedExecutor?: Executor,
): Promise<MetricSourcePreparation> {
  const storeKinds = selectedMetricStoreKinds(plugin.services, config.services);
  if (config.prometheus && storeKinds.length === 0) {
    return {
      source: new RemoteMetricSource(config.prometheus),
      sourceKind: "remote",
      targetCount: config.services.length,
      exporterStoreTargets: 0,
      directStoreTargets: 0,
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
    }, {
      requirement: "preferred",
      rule: { verb: "get", resource: "configmaps" },
      purpose: "解析 Redis/DB 声明配置",
      fallback: "回退读取 Container 运行时 env",
    }, {
      requirement: "preferred",
      rule: { verb: "get", resource: "secrets" },
      purpose: "解析 Redis/DB 声明凭据",
      fallback: "回退读取 Container 运行时 env",
    }, {
      requirement: "preferred",
      rule: { verb: "create", resource: "pods/exec" },
      purpose: "声明配置不足时读取 Redis/DB 运行时 env",
      fallback: "对应 Store 标记为不可用",
    }],
  });

  const forwarder = await ServicePortForwarder.create(executor, config.kube);
  try {
    const targets: EmbeddedMetricTarget[] = [];
    if (!config.prometheus) {
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
    }
    const retentionMs = config.watch.mode === "duration"
      ? config.watch.durationMs + 60_000
      : config.watch.mode === "until-interrupt" ? 60 * 60_000 : 60_000;
    const embeddedSource = new EmbeddedMetricSource({
      targets,
      retentionMs,
      sampleIntervalMs: config.intervalMs,
    });
    let storeCollection: StoreMetricCollection | undefined;
    if (storeKinds.length) {
      storeCollection = await prepareStoreMetricCollection({
        plugin,
        services: config.services,
        executor,
        forwarder,
        namespace: config.namespace,
        intervalMs: config.intervalMs,
      });
    }
    return {
      source: config.prometheus ? new RemoteMetricSource(config.prometheus) : embeddedSource,
      storeSource: config.prometheus ? embeddedSource : undefined,
      sourceKind: config.prometheus ? "hybrid" : "embedded",
      embeddedSource,
      collectSupplement: storeCollection
        ? (source) => storeCollection!.sample(source)
        : undefined,
      targetCount: targets.length + (storeCollection?.targetCount ?? 0),
      exporterStoreTargets: storeCollection?.exporterCount ?? 0,
      directStoreTargets: storeCollection?.directCount ?? 0,
      close: async () => {
        await storeCollection?.close();
        forwarder.stop();
      },
    };
  } catch (error) {
    forwarder.stop();
    throw error;
  }
}
