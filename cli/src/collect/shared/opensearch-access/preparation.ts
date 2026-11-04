import type { Client } from "@compforge/harness-common";
import { clientKey, ClientManager } from "@compforge/harness-common";
import { diagnosticMessage } from "../../../command/diagnostic";
import { currentCommandClients, currentCommandSignal } from "../../../command/execution-scope";
import { DirectTransport, Transport, ServicePortForwardTransport, type TransportPath } from "@compforge/harness-toolbox/transport";
import { describeOpenSearchError, OpenSearchClient } from "@compforge/harness-toolbox/opensearch";
import type { KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { SearchEngine } from "@compforge/harness-toolbox/opensearch/types";
import type { OpenSearchAuth } from "../../../infra/search/opensearch";
import type { StepInput } from "../../evidence";
import { sharedPodRelay } from "../../../datasource/pod-relay";
import type { OpenSearchConnectionPlan } from "./configuration";

export interface OpenSearchAccessPreparation {
  search?: SearchEngine;
  channel?: string;
  baseUrl?: string;
  evidenceTarget?: Record<string, unknown>;
  steps: StepInput[];
  failure?: { title: string; reason: string; diagnostics?: readonly string[] };
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

/** Root cleanup errors remain with ClientManager; recover the failed preparation's evidence for delivery. */
function failedPreparation(error: unknown): OpenSearchAccessPreparation | undefined {
  if (error instanceof OpenSearchPreparationError) return error.preparation;
  if (error instanceof AggregateError) {
    for (const cause of error.errors) {
      const preparation = failedPreparation(cause);
      if (preparation) return preparation;
    }
  }
  return undefined;
}

class OpenSearchAccessClient implements Client {
  #initialization?: Promise<void>;
  #disposal?: Promise<void>;
  #close = async () => {};
  #localClients?: ClientManager;
  preparation!: OpenSearchAccessPreparation;
  constructor(private readonly opts: OpenSearchAccessOptions, private readonly log: (line: string, tone?: "info" | "warning") => void,
    private readonly signal?: AbortSignal, private readonly injectedSearch?: SearchEngine,
    private readonly clients?: Pick<ClientManager, "get">) {}
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
    const { opts, injectedSearch } = this;
    const diagnostics: string[] = [];
    const failureDiagnostics: string[] = [];
    const log = (line: string, tone?: "info" | "warning") => {
      diagnostics.push(`${new Date().toISOString()} ${line}`);
      this.log(line, tone);
    };
    const steps: StepInput[] = [];
    const recordDiagnostics = (status: "ok" | "failed") => steps.push({
      id: "opensearch-access", title: "OpenSearch 访问诊断", risk: "observe", status,
      output: diagnostics.join("\n"), ext: "log",
    });
    let search: SearchEngine | undefined;
    const close = this.#close = async () => {
      try { await search?.close?.(); }
      finally {
        await this.#localClients?.dispose();
      }
    };
    const failed = (
      title: string,
      reason: string,
      evidenceTarget?: Record<string, unknown>,
    ): OpenSearchAccessPreparation => {
      log(`[collect] ${title}：${reason}`, "warning");
      recordDiagnostics("failed");
      return { steps, failure: { title, reason, diagnostics: failureDiagnostics }, evidenceTarget, close };
    };

    const connection = opts.connection;
    if (!connection) return failed("OpenSearch 准备失败", "配置确认阶段未提供连接计划");
    let baseUrl = "";
    let channel = "";
    let preferredScheme: "http" | "https" | undefined;
    let auth = opts.auth;
    // @spec Persist bounded original stack frames before preparation failures become summaries.
    // @why Streamed log lines are already captured by callers; only additional failure evidence is forwarded.
    // Error headers may contain protocol bodies; keep safe codes and sanitized frames in the archive only.
    const recordFailure = (phase: string, error: unknown) => {
      const lines: string[] = [];
      const secrets = [auth.username ?? "", auth.password ?? ""];
      const seen = new Set<unknown>();
      let cause = error;
      for (let depth = 0; cause instanceof Error && !seen.has(cause) && depth < 4; depth++) {
        seen.add(cause);
        lines.push(`${new Date().toISOString()} [collect] OpenSearch ${phase} cause=${depth} ${describeOpenSearchError(cause)}`);
        for (const frame of (cause.stack ?? "").split("\n").filter(line => /^\s+at /.test(line)).slice(0, 16)) {
          lines.push(diagnosticMessage(frame, secrets).slice(0, 1024));
        }
        cause = cause.cause;
      }
      diagnostics.push(...lines);
      failureDiagnostics.push(...lines);
    };
    const clients = this.clients ?? (this.#localClients ??= new ClientManager(this.signal));
    const kube = { kubeconfig: opts.kube?.kubeconfig, context: opts.kube?.context, namespace: opts.kube?.namespace ?? "default" };
    try {
      let transport: Transport;
      if (connection.kind === "service") {
        const service = connection.service;
        const hostPort = `${service.name}.${service.namespace}.svc:${service.port}`;
        baseUrl = connection.scheme ? `${connection.scheme}://${hostPort}` : hostPort;
        preferredScheme = connection.scheme;
        channel = `port-forward svc/${service.name}（${service.namespace}）`;
        transport = await clients.get({
          clientKey: clientKey("service-port-forward", { ...kube, namespace: service.namespace }),
          createClient: (_dependencies, signal) => new ServicePortForwardTransport({
            ...kube, namespace: service.namespace, signal,
          }),
        });
      } else {
        baseUrl = connection.endpoint;
        channel = `直连 ${connection.endpoint}`;
        if (!auth.username && connection.username && connection.password) {
          auth = { username: connection.username, password: connection.password };
        }
        transport = await clients.get({
          clientKey: clientKey("opensearch-transport", { kind: connection.kind, kube }),
          createClient: (dependencies, signal) => {
            const paths: TransportPath[] = [new DirectTransport()];
            if (connection.kind === "target" && opts.kube) paths.push({
              kind: "tcp", name: "pod-relay",
              connect: async (endpoint, attempt) => {
                const relay = await sharedPodRelay(dependencies, kube);
                attempt?.signal.throwIfAborted();
                return relay.connect(endpoint);
              },
            });
            return new Transport(paths, signal);
          },
        });
      }
      const client = injectedSearch ? undefined : new OpenSearchClient({
        node: baseUrl, auth, preferredScheme, connectTimeoutMs: 10_000,
      }, transport, {
        signal: this.signal,
        onDiagnostic: line => log(`[collect] ${line}`),
        onRoute: route => {
          if (route.transport === "pod-relay") channel = `Pod relay（${opts.kube?.namespace ?? "default"}）`;
          steps.push({ id: "channel", title: "OpenSearch 连接", risk: "observe", status: "ok",
            output: `transport=${route.transport}${route.reason ? ` fallback_reason=${route.reason}` : ""}` });
          log(`[collect] OpenSearch 连接成功：${channel}${route.reason ? `（直连失败：${route.reason}）` : ""}`);
        },
      });
      search = injectedSearch ?? client;
      await client?.initialize();
      baseUrl = client?.node ?? baseUrl;
    } catch (error) {
      this.signal?.throwIfAborted();
      const reason = error instanceof Error ? error.message : String(error);
      steps.push({ id: "channel", title: "OpenSearch 连接", risk: "observe", status: "failed", reason });
      recordFailure("connect", error);
      return failed("OpenSearch 连接失败", reason);
    }
    recordDiagnostics("ok");
    return { search, channel, baseUrl, steps, close };
  }
}

/** Each caller owns its protocol client; transports remain shared until root disposal. */
export async function prepareOpenSearchAccess(
  opts: OpenSearchAccessOptions,
  log: (line: string, tone?: "info" | "warning") => void,
  injectedSearch?: SearchEngine,
): Promise<OpenSearchAccessPreparation> {
  const clients = injectedSearch ? undefined : currentCommandClients();
  let local: OpenSearchAccessClient | undefined;
  try {
    const client = clients
      ? await clients.create({ createClient: (_clients, signal) => new OpenSearchAccessClient(opts, log, signal, undefined, _clients) })
      : (local = new OpenSearchAccessClient(opts, log, currentCommandSignal(), injectedSearch));
    if (local) await local.initialize();
    return { ...client.preparation, close: () => client.dispose() };
  } catch (error) {
    const preparation = failedPreparation(error);
    try { await local?.dispose(); }
    catch (cleanup) {
      if (!preparation) throw new AggregateError([error, cleanup], "OpenSearch preparation and cleanup failed", { cause: error });
      // Standalone callers have no root manager to retain cleanup failures. Keep both failures in their evidence.
      preparation.steps.push({ id: "opensearch-cleanup", title: "OpenSearch 资源清理", risk: "observe",
        status: "failed", reason: describeOpenSearchError(cleanup) });
      preparation.failure!.reason += `; cleanup failed: ${describeOpenSearchError(cleanup)}`;
    }
    if (preparation) return { ...preparation, close: async () => {} };
    throw error;
  }
}
