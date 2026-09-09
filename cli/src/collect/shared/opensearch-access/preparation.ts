import type { Client } from "@compforge/doctor-toolkit/client";
import { dataSourceKey } from "@compforge/doctor-toolkit/datasource";
import { currentCommandClients } from "../../../command/execution-scope";
import { DirectTransport } from "@compforge/doctor-toolkit/transport";
import { openOpenSearch } from "@compforge/doctor-toolkit/opensearch";
import { KubectlExecutor, type KubectlOptions } from "@compforge/doctor-toolkit/kubernetes/executor";
import { ServicePortForwarder } from "@compforge/doctor-toolkit/kubernetes/service-port-forward";
import type { SearchEngine } from "@compforge/doctor-toolkit/opensearch/types";
import {
  normalizeOpenSearchHost,
  probeOpenSearchUrl,
  type OpenSearchAuth,
} from "../../../infra/search/opensearch";
import type { StepInput } from "../../evidence";
import type { OpenSearchConnectionPlan } from "./configuration";

export interface OpenSearchAccessPreparation {
  search?: SearchEngine;
  channel?: string;
  baseUrl?: string;
  evidenceTarget?: Record<string, unknown>;
  steps: StepInput[];
  failure?: { title: string; reason: string };
  close(): Promise<void>;
}

export interface OpenSearchAccessOptions {
  connection?: OpenSearchConnectionPlan;
  kube?: KubectlOptions;
  auth: OpenSearchAuth;
}

class OpenSearchPreparationError extends Error {
  constructor(readonly preparation: OpenSearchAccessPreparation) { super(preparation.failure?.reason); }
}

class OpenSearchAccessClient implements Client {
  #initialization?: Promise<void>;
  #disposal?: Promise<void>;
  #close = async () => {};
  preparation!: OpenSearchAccessPreparation;
  constructor(private readonly opts: OpenSearchAccessOptions, private readonly log: (line: string, tone?: "info" | "warning") => void,
    private readonly signal?: AbortSignal, private readonly injectedSearch?: SearchEngine) {}
  initialize(): Promise<void> {
    return this.#initialization ??= (async () => {
      this.signal?.throwIfAborted();
      this.preparation = await this.#prepare();
      if (this.preparation.failure) throw new OpenSearchPreparationError(this.preparation);
    })();
  }
  dispose(): Promise<void> {
    return this.#disposal ??= (async () => {
      await this.#initialization?.catch(() => {});
      await this.#close();
    })();
  }
  async #prepare(): Promise<OpenSearchAccessPreparation> {
    const { opts, log, injectedSearch } = this;
    const steps: StepInput[] = [];
    let forwarder: ServicePortForwarder | undefined;
    let search: SearchEngine | undefined;
    const close = this.#close = async () => {
      try { await search?.close?.(); }
      finally { forwarder?.stop(); }
    };
    const failed = (
      title: string,
      reason: string,
      evidenceTarget?: Record<string, unknown>,
    ): OpenSearchAccessPreparation => ({ steps, failure: { title, reason }, evidenceTarget, close });

    const connection = opts.connection;
    if (!connection) return failed("OpenSearch 准备失败", "配置确认阶段未提供连接计划");
    let hostPort = "";
    let baseUrl = "";
    let channel = "";
    let preferredScheme: "http" | "https" | undefined;
    let auth = opts.auth;
    if (connection.kind === "direct") {
      const normalized = normalizeOpenSearchHost(connection.endpoint);
      baseUrl = normalized.url ?? "";
      hostPort = normalized.hostPort ?? "";
      channel = `直连 ${connection.endpoint}`;
      if (!auth.username && connection.username && connection.password) {
        auth = { username: connection.username, password: connection.password };
      }
      steps.push({ id: "channel", title: "OpenSearch 通道（直连）", risk: "observe", status: "ok" });
    } else {
      const service = connection.service;
      const kube = opts.kube ?? {};
      const executor = new KubectlExecutor({ ...kube, namespace: service.namespace });
      const evidenceTarget = { service: `${service.namespace}/${service.name}` };
      try {
        forwarder = await ServicePortForwarder.create(executor, {
          ...kube,
          namespace: service.namespace,
        });
        log(`[collect] port-forward svc/${service.name}（${service.namespace}，远端端口 ${service.port}）…`);
        const endpoint = await forwarder.forward({ host: service.name, port: service.port });
        const active = forwarder.activeForwards.at(-1);
        steps.push({
          id: "port-forward",
          title: `port-forward svc/${service.name}`,
          risk: "observe",
          status: "ok",
          command: active?.command,
        });
        hostPort = `${endpoint.host}:${endpoint.port}`;
        preferredScheme = connection.scheme;
        channel = `port-forward svc/${service.name}（${service.namespace}）`;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        steps.push({
          id: "port-forward",
          title: `port-forward svc/${service.name}`,
          risk: "observe",
          status: "failed",
          reason,
        });
        forwarder?.stop();
        return failed("port-forward 失败", reason, evidenceTarget);
      }
    }

    if (!baseUrl) {
      try {
        // 现场配置可能滞后于真实 Service TLS 状态；优先配置值，失败后再试另一种 scheme。
        baseUrl = await probeOpenSearchUrl(hostPort, auth, { preferredScheme });
        const selectedScheme = baseUrl.startsWith("https://") ? "https" : "http";
        if (preferredScheme && selectedScheme !== preferredScheme) {
          log(
            `[collect] OpenSearch 配置 scheme=${preferredScheme} 不可用，已回退 ${selectedScheme}`,
            "warning",
          );
        }
        steps.push({
          id: "probe-scheme",
          title: "OpenSearch 连通性探测",
          risk: "observe",
          status: "ok",
          output: preferredScheme
            ? `configured=${preferredScheme} selected=${selectedScheme}`
            : baseUrl,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        steps.push({
          id: "probe-scheme",
          title: "OpenSearch 连通性探测",
          risk: "observe",
          status: "failed",
          reason,
        });
        forwarder?.stop();
        return failed("OpenSearch 不可达", reason);
      }
    }
    search = injectedSearch ?? await openOpenSearch({ resolve: async () => ({ node: baseUrl, auth }), transports: [new DirectTransport()] }, { signal: this.signal });
    return { search, channel, baseUrl, steps, close };
  }
}

/** Acquire shared access; each consumer still creates its own evidence from the preparation facts. */
export async function prepareOpenSearchAccess(
  opts: OpenSearchAccessOptions,
  log: (line: string, tone?: "info" | "warning") => void,
  injectedSearch?: SearchEngine,
): Promise<OpenSearchAccessPreparation> {
  const clients = injectedSearch ? undefined : currentCommandClients();
  let local: OpenSearchAccessClient | undefined;
  try {
    const client = clients
      ? await clients.get({ key: dataSourceKey("opensearch-access", opts), createClient: signal => new OpenSearchAccessClient(opts, log, signal) })
      : (local = new OpenSearchAccessClient(opts, log, undefined, injectedSearch));
    if (local) await local.initialize();
    return { ...client.preparation, close: local ? () => client.dispose() : async () => {} };
  } catch (error) {
    await local?.dispose();
    if (error instanceof OpenSearchPreparationError) return { ...error.preparation, close: async () => {} };
    throw error;
  }
}
