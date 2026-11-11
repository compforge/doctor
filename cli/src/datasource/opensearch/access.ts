import { clientKey, ClientManager, type Client } from "@compforge/harness-common";
import { DirectTransport, Transport, ServicePortForwardTransport, type TransportPath } from "@compforge/harness-toolbox/transport";
import { OpenSearchClient, type OpenSearchAuth, type OpenSearchLifecycle, type SearchEngine } from "@compforge/harness-toolbox/opensearch";
import type { KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { OpenSearchService } from "../../infra/search/opensearch/k8s";
import { sharedPodRelay } from "../pod-relay";

export type OpenSearchConnectionPlan =
  | {
      kind: "direct" | "target";
      endpoint: string;
      username?: string;
      password?: string;
    }
  | {
      kind: "service";
      service: OpenSearchService;
      scheme?: "http" | "https";
    };

export interface OpenSearchAccessOptions extends Pick<OpenSearchLifecycle, "signal" | "onRoute" | "onDiagnostic"> {
  connection: OpenSearchConnectionPlan;
  kube?: KubectlOptions;
  auth: OpenSearchAuth;
  clients?: Pick<ClientManager, "get" | "create">;
}

export interface OpenSearchAccess {
  search: SearchEngine;
  baseUrl: string;
  close(): Promise<void>;
}

/** @rule Keep the original connection error separate from cleanup errors; presentation belongs to the caller. */
export class OpenSearchAccessError extends Error {
  readonly cleanupErrors: unknown[] = [];
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "OpenSearchAccessError";
  }
}

function accessFailure(error: unknown): OpenSearchAccessError | undefined {
  if (error instanceof OpenSearchAccessError) return error;
  if (error instanceof AggregateError) {
    for (const cause of error.errors) {
      const failure = accessFailure(cause);
      if (failure) return failure;
    }
  }
  return undefined;
}

class OpenSearchAccessClient implements Client {
  #initialization?: Promise<void>;
  #disposal?: Promise<void>;
  #localClients?: ClientManager;
  search?: SearchEngine;
  baseUrl = "";
  constructor(private readonly opts: OpenSearchAccessOptions, private readonly injectedSearch?: SearchEngine,
    private readonly clients?: Pick<ClientManager, "get">, private readonly signal = opts.signal) {}

  initialize(): Promise<void> {
    return this.#initialization ??= (async () => {
      this.signal?.throwIfAborted();
      try { await this.#connect(); }
      catch (error) {
        this.signal?.throwIfAborted();
        throw new OpenSearchAccessError(error);
      }
    })();
  }

  dispose(): Promise<void> {
    return this.#disposal ??= (async () => {
      await this.#initialization?.catch(() => {});
      try { await this.search?.close?.(); }
      finally { await this.#localClients?.dispose(); }
    })();
  }

  async #connect(): Promise<void> {
    const { opts } = this;
    const connection = opts.connection;
    let auth = opts.auth;
    let preferredScheme: "http" | "https" | undefined;
    const clients = this.clients ?? (this.#localClients ??= new ClientManager(this.signal));
    const kube = { kubeconfig: opts.kube?.kubeconfig, context: opts.kube?.context, namespace: opts.kube?.namespace ?? "default" };
    let transport: Transport;
    if (connection.kind === "service") {
      const service = connection.service;
      const hostPort = `${service.name}.${service.namespace}.svc:${service.port}`;
      this.baseUrl = connection.scheme ? `${connection.scheme}://${hostPort}` : hostPort;
      preferredScheme = connection.scheme;
      transport = await clients.get({
        clientKey: clientKey("service-port-forward", { ...kube, namespace: service.namespace }),
        createClient: (_dependencies, signal) => new ServicePortForwardTransport({
          ...kube, namespace: service.namespace, signal,
        }),
      });
    } else {
      this.baseUrl = connection.endpoint;
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
    const client = this.injectedSearch ? undefined : new OpenSearchClient({
      node: this.baseUrl, auth, preferredScheme, connectTimeoutMs: 10_000,
    }, transport, { signal: this.signal, onDiagnostic: opts.onDiagnostic, onRoute: opts.onRoute });
    this.search = this.injectedSearch ?? client;
    await client?.initialize();
    this.baseUrl = client?.node ?? this.baseUrl;
  }
}

/**
 * @spec Each access owns its protocol client; borrowed transports live until root disposal.
 * @rule Without a root manager, access owns and disposes its local transports as well.
 * @see {@link ../../../docs/datasource.md}
 */
export async function openOpenSearchAccess(opts: OpenSearchAccessOptions, injectedSearch?: SearchEngine): Promise<OpenSearchAccess> {
  let local: OpenSearchAccessClient | undefined;
  try {
    const client = opts.clients
      ? await opts.clients.create({ createClient: (clients, signal) => new OpenSearchAccessClient(opts, injectedSearch, clients, opts.signal ? AbortSignal.any([signal, opts.signal]) : signal) })
      : (local = new OpenSearchAccessClient(opts, injectedSearch));
    if (local) await local.initialize();
    return { search: client.search!, baseUrl: client.baseUrl, close: () => client.dispose() };
  } catch (error) {
    const failure = accessFailure(error);
    try { await local?.dispose(); }
    catch (cleanup) {
      if (!failure) throw new AggregateError([error, cleanup], "OpenSearch access and cleanup failed", { cause: error });
      failure.cleanupErrors.push(cleanup);
    }
    // Root-managed cleanup failures remain registered with the manager for finalize.
    throw failure ?? error;
  }
}
