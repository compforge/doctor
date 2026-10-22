import { clientKey, type ClientManager } from "@compforge/harness-common";
import { KubernetesClient } from "@compforge/harness-toolbox/kubernetes/client";
import { KubectlExecutor, type Executor, type ExecResult, type KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { Resource, ResourceList, ResourceRef, ResourceListQuery, NamespaceResources, ResourceRequestOptions } from "@compforge/harness-toolbox/kubernetes/resources";

const RESOURCE_LIMITS = { timeoutMs: 20_000, concurrency: 4, maxBytes: 4 * 1024 * 1024 };

/** Core and Plugin borrow one command-owned client; request policy is checked by each caller. */
export function kubernetesClientSource(kube: KubectlOptions & { namespace: string }, executor?: Executor) {
  return {
    clientKey: clientKey("kubernetes", { namespace: kube.namespace, kubeconfig: kube.kubeconfig, context: kube.context, resourceLimits: RESOURCE_LIMITS }),
    createClient: (_clients: Pick<ClientManager, "get">, signal: AbortSignal) =>
      new KubernetesClient(kube, signal, executor instanceof KubectlExecutor ? undefined : executor, RESOURCE_LIMITS),
  };
}

export type KubernetesResourceQuery = ResourceRef | ResourceListQuery;
export interface KubernetesResourceCapture {
  request: KubernetesResourceQuery & { verb: "get" | "list" };
  value?: Resource | ResourceList;
  error?: string;
  durationMs: number;
  observedAt: string;
  execution?: ExecResult;
  reused?: boolean;
}
export type KubernetesResourceReader = (query: KubernetesResourceQuery) => Promise<KubernetesResourceCapture>;

/** @spec API evidence describes a resource request, never a fabricated kubectl execution. */
export function resourceReader(client: KubernetesClient, signal: AbortSignal): KubernetesResourceReader {
  return async query => {
    const started = performance.now();
    const request = { ...query, verb: "name" in query ? "get" as const : "list" as const };
    try {
      const value = "name" in query ? await client.get(query, { signal }) : await client.list(query, { signal });
      return { request, value, observedAt: new Date().toISOString(), durationMs: performance.now() - started };
    } catch (error) {
      signal.throwIfAborted();
      return { request, error: error instanceof Error ? error.message : String(error),
        observedAt: new Date().toISOString(), durationMs: performance.now() - started };
    }
  };
}

/** Adapter for consumers that explicitly supply a command executor, including offline fixtures. */
export function executorResourceReader(executor: Executor, namespace: string, signal?: AbortSignal): KubernetesResourceReader {
  return async query => {
    const started = performance.now();
    const request = { ...query, namespace: query.namespace ?? namespace, verb: "name" in query ? "get" as const : "list" as const };
    let execution: ExecResult | undefined;
    try {
      const args = ["get", query.resource, ...("name" in query ? [query.name] : []),
        ...("labelSelector" in query && query.labelSelector ? ["-l", query.labelSelector] : []), "-o", "json"];
      execution = await executor.run(args, { timeoutMs: 30_000, signal });
      if (!execution.ok) throw new Error(execution.stderr.trim() || "Read Kubernetes resource failed");
      return { request, value: JSON.parse(execution.stdout), execution,
        observedAt: new Date().toISOString(), durationMs: execution.durationMs };
    } catch (error) {
      signal?.throwIfAborted();
      return { request, execution, error: error instanceof Error ? error.message : String(error),
        observedAt: new Date().toISOString(), durationMs: execution?.durationMs ?? performance.now() - started };
    }
  };
}

/** @spec Reuse successful observations only within one Inspect; incomplete lists never establish named objects. */
export function snapshotResourceReader(read: KubernetesResourceReader): KubernetesResourceReader {
  const observed = new Map<string, KubernetesResourceCapture>();
  const key = (query: KubernetesResourceQuery) => JSON.stringify(Object.entries(query).sort(([a], [b]) => a.localeCompare(b)));
  return async query => {
    const existing = observed.get(key(query));
    if (existing) return { ...existing, durationMs: 0, reused: true };
    const capture = await read(query);
    if (!capture.error && capture.value) {
      observed.set(key(query), capture);
      if (!("name" in query) && !query.continue && !query.labelSelector && !query.fieldSelector
        && Array.isArray(capture.value.items) && !capture.value.metadata?.continue) {
        for (const item of capture.value.items as Resource[]) {
          if (!item.metadata?.name) continue;
          const ref = { apiVersion: query.apiVersion, resource: query.resource, namespace: query.namespace, name: item.metadata.name };
          observed.set(key(ref), { ...capture, request: { ...ref, verb: "get" }, value: item, reused: true });
        }
      }
    }
    return capture;
  };
}

/** Borrow Inspect observations after capability authorization, without extending their lifetime beyond the command. */
export function capturedResourceAccess(read: KubernetesResourceReader, namespace: string): NamespaceResources {
  const value = async (query: KubernetesResourceQuery, options?: ResourceRequestOptions) => {
    options?.signal?.throwIfAborted();
    const capture = await read({ ...query, namespace });
    options?.signal?.throwIfAborted();
    if (capture.error || !capture.value) throw new Error(capture.error ?? "Resource response missing");
    return capture.value;
  };
  return {
    get: async (query, options) => await value(query, options) as Resource,
    list: async (query, options) => await value(query, options) as ResourceList,
  };
}
