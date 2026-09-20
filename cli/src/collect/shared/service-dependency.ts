import type {
  PluginDefinition,
  ResolvedServiceDataSourceDependency,
  ServiceDefinition,
  ServiceDataSourceDependency,
} from "@compforge/doctor-plugin";
import { serviceDataSources, servicesWithDataSource } from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import { resolveKubernetesCommandContext } from "../../command";
import type { KubernetesCommandConfig } from "../../command/kubernetes-target";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { SearchEngine } from "@compforge/harness-toolbox/opensearch/types";
import {
  parseOpenSearchEndpoint,
  resolveOpenSearchAuth,
  type OpenSearchAuth,
} from "../../infra/search/opensearch";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import { terminalStdout } from "../../terminal/output";
import { borrowServiceClient } from "../../datasource/client";
import type { StepInput } from "../evidence";
import { resolveStoreProviderConfig } from "../store/config";
import { confirmInspectedVdbTarget, confirmVdbTarget } from "../store/vdb/configuration";
import {
  confirmOpenSearchConnection,
  prepareOpenSearchAccess,
  type OpenSearchAccessPreparation,
} from "./opensearch-access";

export interface PreparedServiceDataSourceDependency {
  search: SearchEngine;
  preparation: OpenSearchAccessPreparation;
  steps: readonly StepInput[];
  evidenceTarget: Record<string, unknown>;
  configuredEndpoint?: string;
  auth: OpenSearchAuth;
}

export interface ServiceDataSourceReference {
  service: string;
  dataSource: string;
}

/** Declared Store is preferred; remaining Plugin OpenSearch VDB Stores are ordered fallbacks. */
export function openSearchDataSourceCandidates(
  plugin: PluginDefinition,
  preferred?: ServiceDataSourceReference,
): ServiceDataSourceReference[] {
  const candidates: ServiceDataSourceReference[] = preferred ? [{ ...preferred }] : [];
  const seen = new Set(candidates.map(({ service, dataSource }) => `${service}\0${dataSource}`));
  for (const service of servicesWithDataSource(plugin.services, "vdb")) {
    for (const dataSource of serviceDataSources(plugin.services, service.name, "vdb")) {
      if (dataSource.kind !== "vdb" || dataSource.backend !== "opensearch") continue;
      const key = `${service.name}\0${dataSource.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ service: service.name, dataSource: dataSource.id });
    }
  }
  return candidates;
}

export async function prepareFirstAvailableDataSource<T>(
  candidates: readonly ServiceDataSourceReference[],
  prepare: (candidate: ServiceDataSourceReference) => Promise<T>,
  onFailure: (candidate: ServiceDataSourceReference, reason: string) => void,
): Promise<T> {
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return await prepare(candidate);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${candidate.service}/${candidate.dataSource}: ${reason}`);
      onFailure(candidate, reason);
    }
  }
  throw new Error(`所有 OpenSearch Store target 均不可用：${failures.join("；")}`);
}

export interface ServiceDependencyRuntimeOptions {
  plugin: PluginDefinition;
  collect: KubernetesCommandConfig;
  executor: Executor;
  command: "doctor trace" | "doctor log";
  commandContext: CommandContext;
  index: string;
  endpoint?: string;
  serviceName?: string;
  username?: string;
  password?: string;
  log(line: string, tone?: "info" | "warning"): void;
}

function safeEndpoint(value: string): string {
  try {
    return parseOpenSearchEndpoint(value).safeUrl;
  } catch {
    return "<invalid endpoint>";
  }
}

/**
 * Resolves Service-declared Store dependencies into read-only handles. Core owns target discovery,
 * credentials, port-forward and cleanup; Plugin code only receives an index-bound search function.
 */
export class ServiceDependencyRuntime {
  private readonly dataSources = new Map<string, Promise<PreparedServiceDataSourceDependency>>();
  private accessPrepared = false;

  constructor(private readonly options: ServiceDependencyRuntimeOptions) { }

  async resolve(
    service: ServiceDefinition,
  ): Promise<Readonly<Record<string, ResolvedServiceDataSourceDependency>>> {
    const resolved: Record<string, ResolvedServiceDataSourceDependency> = {};
    for (const dependency of service.dependencies ?? []) {
      resolved[dependency.id] = await this.resolveDataSource(dependency);
    }
    return resolved;
  }

  async prepareDataSource(service: string, dataSource: string): Promise<PreparedServiceDataSourceDependency> {
    const key = `${service}\0${dataSource}`;
    let prepared = this.dataSources.get(key);
    if (!prepared) {
      prepared = this.openDataSource(service, dataSource);
      this.dataSources.set(key, prepared);
    }
    return prepared;
  }

  async prepareDataSourceCandidates(
    candidates: readonly ServiceDataSourceReference[],
  ): Promise<PreparedServiceDataSourceDependency> {
    return prepareFirstAvailableDataSource(
      candidates,
      ({ service, dataSource }) => this.prepareDataSource(service, dataSource),
      ({ service, dataSource }, reason) => this.options.log(
        `[collect] OpenSearch Store ${service}/${dataSource} 不可用，尝试下一个 target：${reason}`,
        "warning",
      ),
    );
  }

  async close(): Promise<void> {
    const dataSources = await Promise.allSettled(this.dataSources.values());
    const preparations = dataSources.flatMap((result) => (
      result.status === "fulfilled" ? [result.value.preparation] : []
    ));
    const closed = await Promise.allSettled(preparations.map((preparation) => preparation.close()));
    const failure = closed.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private async resolveDataSource(
    dependency: ServiceDataSourceDependency,
  ): Promise<ResolvedServiceDataSourceDependency> {
    const prepared = await this.prepareDataSourceCandidates(openSearchDataSourceCandidates(
      this.options.plugin,
      { service: dependency.service, dataSource: dependency.dataSource },
    ));
    return {
      ...dependency,
      access: {
        kind: "opensearch",
        search: {
          search: (body) => prepared.search.search(this.options.index, { ...body }),
        },
      },
    };
  }

  private async prepareKubernetesAccess(): Promise<void> {
    if (this.accessPrepared || this.options.endpoint) return;
    this.accessPrepared = true;
    await enforceKubernetesAccess(
      resolveKubernetesCommandContext(this.options.executor, this.options.commandContext).access,
      {
        command: `${this.options.command} · Service capability dependencies`,
        needs: [
          { requirement: "required", rule: { verb: "list", resource: "services" }, purpose: "定位 Store 配置来源和 OpenSearch Service" },
          { requirement: "required", rule: { verb: "list", resource: "pods" }, purpose: "定位 Store 配置来源 Pod" },
          { requirement: "preferred", rule: { verb: "get", resource: "configmaps" }, purpose: "读取 OpenSearch 配置", fallback: "回退读取 Container 运行时配置" },
          { requirement: "preferred", rule: { verb: "get", resource: "secrets" }, purpose: "读取 OpenSearch 凭据", fallback: "回退读取 Container 运行时配置" },
          { requirement: "preferred", rule: { verb: "create", resource: "pods/exec" }, purpose: "声明配置不足时读取 Container 运行时配置", fallback: "配置不足时回退自动发现 OpenSearch" },
          { requirement: "required", rule: { verb: "create", resource: "pods/portforward" }, purpose: "访问集群内 OpenSearch" },
        ],
      },
    );
  }

  private async openDataSource(
    service: string,
    dataSource: string,
  ): Promise<PreparedServiceDataSourceDependency> {
    const capability = serviceDataSources(this.options.plugin.services, service, "vdb").find(item => item.id === dataSource);
    if (!this.options.endpoint && capability?.kind === "vdb" && capability.source) {
      const client = await borrowServiceClient(this.options.commandContext, this.options.collect,
        this.options.executor, service, capability, capability.source);
      const endpoint = client.target.endpoint ? safeEndpoint(client.target.endpoint) : undefined;
      // The root owns this client; closing a dependency view cannot close sibling consumers.
      const evidenceTarget = { service, dataSource, endpoint, channel: "plugin" };
      const preparation: OpenSearchAccessPreparation = {
        search: client.access, channel: "plugin", baseUrl: endpoint,
        evidenceTarget, steps: [], close: async () => { }
      };
      return {
        search: client.access, preparation, steps: [], configuredEndpoint: endpoint, auth: {},
        evidenceTarget
      };
    }
    await this.prepareKubernetesAccess();
    let configuredEndpoint: string | undefined;
    let configuredAuth: OpenSearchAuth = {};

    if (!this.options.endpoint) {
      const resolved = await resolveStoreProviderConfig({
        type: "vdb",
        service,
        store: dataSource,
      }, this.options.plugin, this.options.collect, this.options.executor, this.options.commandContext);
      if (!resolved) throw new Error(`Store capability '${service}/${dataSource}' 未选择运行目标`);
      if (resolved.config.capability.kind !== "vdb") {
        throw new Error(`Store capability '${service}/${dataSource}' 不是 VDB`);
      }
      const confirmed = resolved.config.vdbTarget
        ? confirmInspectedVdbTarget(resolved.config.vdbTarget)
        : resolved.config.target
          ? await confirmVdbTarget(
            this.options.executor,
            resolved.config.target,
            resolved.config.capability,
          )
          : { captures: [], reason: `Store capability '${service}/${dataSource}' 未提供 VDB target` };
      if (confirmed.connection?.type !== "opensearch") {
        throw new Error(
          confirmed.reason ?? `Store capability '${service}/${dataSource}' 未提供 OpenSearch 连接`,
        );
      }
      configuredEndpoint = confirmed.connection.endpoint;
      if (confirmed.connection.username && confirmed.connection.password) {
        configuredAuth = {
          username: confirmed.connection.username,
          password: confirmed.connection.password,
        };
      }
      if (configuredEndpoint) {
        terminalStdout.write(
          `[collect] Service ${service}（Store ${dataSource}）提供配置：OpenSearch endpoint=${safeEndpoint(configuredEndpoint)}\n`,
        );
      } else {
        this.options.log(
          confirmed.reason ?? "业务 Service 未提供 OpenSearch endpoint，将自动发现",
          "warning",
        );
      }
    }

    const kube: KubectlOptions = {
      kubeconfig: this.options.collect.kubernetes.kubeconfig,
      context: this.options.collect.kubernetes.context,
      namespace: configuredEndpoint ? this.options.collect.kubernetes.namespace : undefined,
    };
    const confirmation = await confirmOpenSearchConnection({
      endpoint: this.options.endpoint,
      configuredEndpoint,
      serviceName: this.options.serviceName,
      kube,
    }, this.options.log);
    if (confirmation.failure) {
      throw new Error(`${confirmation.failure.title}：${confirmation.failure.reason}`);
    }

    const explicitAuth = resolveOpenSearchAuth(this.options.username, this.options.password);
    const auth = explicitAuth.username ? explicitAuth : configuredAuth;
    const preparation = await prepareOpenSearchAccess({
      connection: confirmation.connection,
      kube,
      auth,
    }, this.options.log);
    if (preparation.failure || !preparation.search) {
      const failure = preparation.failure ?? {
        title: "OpenSearch 准备失败",
        reason: "访问通道不完整",
      };
      await preparation.close();
      throw new Error(`${failure.title}：${failure.reason}`);
    }
    return {
      search: preparation.search,
      preparation,
      steps: [...confirmation.steps, ...preparation.steps],
      evidenceTarget: {
        ...confirmation.evidenceTarget,
        ...preparation.evidenceTarget,
      },
      configuredEndpoint,
      auth,
    };
  }
}
