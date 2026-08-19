import type {
  PluginDefinition,
  ResolvedServiceCapabilityDependency,
  ServiceDefinition,
  ServiceStoreCapabilityDependency,
} from "@compforge/doctor-plugin";
import { serviceStores, servicesWithStore } from "@compforge/doctor-plugin";
import type { CommandContext } from "../../command";
import { resolveKubernetesCommandContext } from "../../command";
import type { KubernetesCommandConfig } from "../../command/kubernetes-target";
import type { Executor, KubectlOptions } from "../../infra/k8s/executor";
import type { SearchEngine } from "../../infra/search";
import {
  parseOpenSearchEndpoint,
  resolveOpenSearchAuth,
  type OpenSearchAuth,
} from "../../infra/search/opensearch";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import { terminalStdout } from "../../terminal/output";
import type { StepInput } from "../evidence";
import { resolveStoreProviderConfig } from "../store/config";
import { confirmVdbTarget } from "../store/vdb/configuration";
import {
  confirmOpenSearchConnection,
  prepareOpenSearchAccess,
  type OpenSearchAccessPreparation,
} from "./opensearch-access";

export interface PreparedServiceStoreDependency {
  search: SearchEngine;
  preparation: OpenSearchAccessPreparation;
  steps: readonly StepInput[];
  evidenceTarget: Record<string, unknown>;
  configuredEndpoint?: string;
  auth: OpenSearchAuth;
}

export interface ServiceStoreReference {
  service: string;
  store: string;
}

/** Declared Store is preferred; remaining Plugin OpenSearch VDB Stores are ordered fallbacks. */
export function openSearchStoreCandidates(
  plugin: PluginDefinition,
  preferred?: ServiceStoreReference,
): ServiceStoreReference[] {
  const candidates: ServiceStoreReference[] = preferred ? [{ ...preferred }] : [];
  const seen = new Set(candidates.map(({ service, store }) => `${service}\0${store}`));
  for (const service of servicesWithStore(plugin.services, "vdb")) {
    for (const store of serviceStores(plugin.services, service.name, "vdb")) {
      if (store.kind !== "vdb" || store.backend !== "opensearch") continue;
      const key = `${service.name}\0${store.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ service: service.name, store: store.id });
    }
  }
  return candidates;
}

export async function prepareFirstAvailableStore<T>(
  candidates: readonly ServiceStoreReference[],
  prepare: (candidate: ServiceStoreReference) => Promise<T>,
  onFailure: (candidate: ServiceStoreReference, reason: string) => void,
): Promise<T> {
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return await prepare(candidate);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${candidate.service}/${candidate.store}: ${reason}`);
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
  commandContext?: CommandContext;
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
  private readonly stores = new Map<string, Promise<PreparedServiceStoreDependency>>();
  private accessPrepared = false;

  constructor(private readonly options: ServiceDependencyRuntimeOptions) {}

  async resolve(
    service: ServiceDefinition,
  ): Promise<Readonly<Record<string, ResolvedServiceCapabilityDependency>>> {
    const resolved: Record<string, ResolvedServiceCapabilityDependency> = {};
    for (const dependency of service.dependencies ?? []) {
      resolved[dependency.id] = await this.resolveStore(dependency);
    }
    return resolved;
  }

  async prepareStore(service: string, store: string): Promise<PreparedServiceStoreDependency> {
    const key = `${service}\0${store}`;
    let prepared = this.stores.get(key);
    if (!prepared) {
      prepared = this.openStore(service, store);
      this.stores.set(key, prepared);
    }
    return prepared;
  }

  async prepareStoreCandidates(
    candidates: readonly ServiceStoreReference[],
  ): Promise<PreparedServiceStoreDependency> {
    return prepareFirstAvailableStore(
      candidates,
      ({ service, store }) => this.prepareStore(service, store),
      ({ service, store }, reason) => this.options.log(
        `[collect] OpenSearch Store ${service}/${store} 不可用，尝试下一个 target：${reason}`,
        "warning",
      ),
    );
  }

  async close(): Promise<void> {
    const stores = await Promise.allSettled(this.stores.values());
    const preparations = stores.flatMap((result) => (
      result.status === "fulfilled" ? [result.value.preparation] : []
    ));
    const closed = await Promise.allSettled(preparations.map((preparation) => preparation.close()));
    const failure = closed.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  private async resolveStore(
    dependency: ServiceStoreCapabilityDependency,
  ): Promise<ResolvedServiceCapabilityDependency> {
    const prepared = await this.prepareStoreCandidates(openSearchStoreCandidates(
      this.options.plugin,
      { service: dependency.service, store: dependency.store },
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

  private async openStore(
    service: string,
    store: string,
  ): Promise<PreparedServiceStoreDependency> {
    await this.prepareKubernetesAccess();
    let configuredEndpoint: string | undefined;
    let configuredAuth: OpenSearchAuth = {};

    if (!this.options.endpoint) {
      const resolved = await resolveStoreProviderConfig({
        type: "vdb",
        service,
        store,
      }, this.options.plugin, this.options.collect, this.options.executor, this.options.commandContext);
      if (!resolved) throw new Error(`Store capability '${service}/${store}' 未选择运行目标`);
      if (resolved.config.capability.kind !== "vdb") {
        throw new Error(`Store capability '${service}/${store}' 不是 VDB`);
      }
      const confirmed = await confirmVdbTarget(
        this.options.executor,
        resolved.config.target,
        resolved.config.capability,
      );
      if (confirmed.connection?.type !== "opensearch") {
        throw new Error(
          confirmed.reason ?? `Store capability '${service}/${store}' 未提供 OpenSearch 连接`,
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
          `[collect] Service ${service}（Store ${store}）提供配置：OpenSearch endpoint=${safeEndpoint(configuredEndpoint)}\n`,
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
