import { KubectlExecutor, type Executor, type KubectlOptions } from "../../../infra/k8s/executor";
import { serviceIdentity } from "../../../infra/k8s/service";
import {
  parseOpenSearchEndpoint,
  pickOpenSearchService,
  type OpenSearchService,
} from "../../../infra/search/opensearch";
import type { StepInput } from "../../evidence";

export type OpenSearchConnectionPlan =
  | {
      kind: "direct";
      endpoint: string;
      username?: string;
      password?: string;
    }
  | {
      kind: "service";
      service: OpenSearchService;
      scheme?: "http" | "https";
    };

export interface OpenSearchConnectionConfirmation {
  connection?: OpenSearchConnectionPlan;
  evidenceTarget?: Record<string, unknown>;
  steps: StepInput[];
  failure?: { title: string; reason: string };
}

export interface ConfirmOpenSearchConnectionOptions {
  /** Doctor Host 可直接访问的稳定入口，优先级最高。 */
  endpoint?: string;
  /** 从被诊断对象配置中提取的入口，可能是 K8s Service DNS。 */
  configuredEndpoint?: string;
  serviceName?: string;
  kube?: KubectlOptions;
}

export type OpenSearchAccessLog = (
  line: string,
  tone?: "info" | "warning",
) => void;

/**
 * 把 OpenSearch 连接入口确认成 direct 或 Service 两种计划；这里只确认，不建立网络通道。
 * endpoint 是 Doctor Host 可直连的地址，configuredEndpoint 则属于当前诊断 target 的现场 Fact。
 */
export async function confirmOpenSearchConnection(
  opts: ConfirmOpenSearchConnectionOptions,
  log: OpenSearchAccessLog,
  injectedExecutor?: Executor,
): Promise<OpenSearchConnectionConfirmation> {
  if (opts.endpoint) {
    try {
      const parsed = parseOpenSearchEndpoint(opts.endpoint);
      return {
        connection: {
          kind: "direct",
          endpoint: parsed.safeEndpoint,
          username: parsed.username,
          password: parsed.password,
        },
        evidenceTarget: { endpoint: parsed.safeUrl },
        steps: [],
      };
    } catch (error) {
      return {
        steps: [],
        failure: {
          title: "OpenSearch endpoint 无效",
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  let configured;
  if (opts.configuredEndpoint) {
    try {
      configured = parseOpenSearchEndpoint(opts.configuredEndpoint);
    } catch (error) {
      return {
        steps: [],
        failure: {
          title: "OpenSearch endpoint 无效",
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (!opts.serviceName) {
      const identity = serviceIdentity(configured.host, opts.kube?.namespace ?? "default");
      if (!identity) {
        return {
          connection: {
            kind: "direct",
            endpoint: configured.safeEndpoint,
            username: configured.username,
            password: configured.password,
          },
          evidenceTarget: { endpoint: configured.safeUrl },
          steps: [],
        };
      }
    }
  }

  const identity = configured
    ? serviceIdentity(configured.host, opts.kube?.namespace ?? "default")
    : undefined;
  const namespace = identity?.namespace ?? opts.kube?.namespace;
  const serviceName = opts.serviceName ?? identity?.name;
  const executor = injectedExecutor ?? new KubectlExecutor({ ...(opts.kube ?? {}), namespace });
  if (!configured && !serviceName) {
    log("[collect] 未取得 OpenSearch target 配置，跨 namespace 自动发现 service…", "warning");
  } else {
    log(
      `[collect] 定位 OpenSearch service: ${namespace ? `${namespace}/` : ""}${serviceName ?? "auto"}…`,
    );
  }
  const args = namespace ? ["get", "svc", "-o", "json"] : ["get", "svc", "-A", "-o", "json"];
  const result = await executor.run(args, { timeoutMs: 30_000 });
  const step: StepInput = {
    id: "svc-discovery",
    title: "OpenSearch service 发现",
    risk: "observe",
    status: result.ok ? "ok" : "failed",
    reason: result.ok ? undefined : result.stderr.trim().split("\n")[0] || `exit=${result.exitCode}`,
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
  if (!result.ok) {
    return {
      steps: [step],
      failure: { title: "svc 列表获取失败", reason: step.reason ?? `exit=${result.exitCode}` },
    };
  }
  const picked = pickOpenSearchService(result.stdout, serviceName, configured?.port);
  if (!picked.ok) {
    return { steps: [step], failure: { title: "service 定位失败", reason: picked.reason } };
  }
  return {
    connection: {
      kind: "service",
      service: picked.value,
      scheme: configured?.schemeExplicit ? configured.scheme : undefined,
    },
    evidenceTarget: { service: `${picked.value.namespace}/${picked.value.name}` },
    steps: [step],
  };
}
