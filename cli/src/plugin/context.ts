import { kubernetesClientSource, capturedResourceAccess, type KubernetesResourceReader } from "../infra/k8s/resources";
import { PodFileDataSource } from "@compforge/harness-toolbox/file";
import { hostname } from "node:os";
import { clientKey } from "@compforge/harness-common";
import { ClientManager } from "@compforge/harness-common";
import { resolveKubernetesEnvironment, bindKubernetesEnvironment, type ResolvedKubernetesEnvironment } from "../infra/k8s/environment";
import { sharedPodRelay } from "../datasource/pod-relay";
import { KubernetesClient } from "@compforge/harness-toolbox/kubernetes/client";
import type { NamespaceResources } from "@compforge/harness-toolbox/kubernetes/resources";
import { KubectlExecutor } from "@compforge/harness-toolbox/kubernetes/executor";
import { currentCommandClients, currentCommandSignal, onCommandDispose } from "../command/execution-scope";
import { bindService, type ServiceDefinition } from "@compforge/doctor-plugin";
import type {
  CapabilityWithAccess,
  DatabaseIdentity,
  KubernetesAccess,
  KubernetesResourceRef,
  KubernetesResourceListQuery,
  KubernetesResourceList,
  PluginContext,
  PluginClientContext,
  ResolvedServiceDataSourceDependency,
} from "@compforge/doctor-plugin";
import type {
  KubernetesAccessContext,
  KubernetesAccessNeed,
} from "../infra/k8s/access";
import type {
  ExecResult,
  Executor,
  KubectlOptions,
} from "@compforge/harness-toolbox/kubernetes/executor";
import { enforceKubernetesAccess } from "../terminal/kubernetes-access";

const PLUGIN_KUBERNETES_TIMEOUT_MS = 20_000;
const PLUGIN_KUBERNETES_OUTPUT_LIMIT = 4 * 1024 * 1024;

function capabilityAccessNeeds(capability: CapabilityWithAccess): KubernetesAccessNeed[] {
  const needs = [...(capability.access.kubernetes ?? [])];
  // Native WebSocket exec uses GET; declared exec capability also covers kubectl-backed paths.
  for (const need of [...needs]) {
    if (need.rule.verb === "create" && need.rule.resource === "pods/exec") needs.push({
      ...need, rule: { ...need.rule, verb: "get" }, purpose: "Core 原生 exec WebSocket 握手",
    });
  }
  const portForward = needs.find((need) => (
    need.rule.verb === "create" && need.rule.resource === "pods/portforward"
  ));
  if (portForward) {
    needs.push({
      rule: { verb: "list", resource: "services", allNamespaces: portForward.rule.allNamespaces },
      requirement: portForward.requirement,
      purpose: "Core 为 port-forward 解析 Service target",
      fallback: portForward.fallback,
    }, {
      rule: { verb: "list", resource: "pods", allNamespaces: portForward.rule.allNamespaces },
      requirement: portForward.requirement,
      purpose: "Core 为 port-forward 解析 Pod target",
      fallback: portForward.fallback,
    });
  }
  const merged = new Map<string, KubernetesAccessNeed>();
  for (const need of needs) {
    const rule = need.rule;
    const key = `${rule.verb}:${rule.resource}:${rule.resourceName ?? ""}:${rule.allNamespaces ? "all" : ""}`;
    const previous = merged.get(key);
    if (!previous || need.requirement === "required") merged.set(key, need);
  }
  return [...merged.values()];
}

function checkedOutput(label: string, result: ExecResult): string {
  const outputBytes = new TextEncoder().encode(result.stdout).byteLength
    + new TextEncoder().encode(result.stderr).byteLength;
  if (outputBytes > PLUGIN_KUBERNETES_OUTPUT_LIMIT) {
    throw new Error(`${label} 输出超过 ${PLUGIN_KUBERNETES_OUTPUT_LIMIT} bytes`);
  }
  if (result.ok) return result.stdout;
  const reason = result.stderr.trim().split("\n")[0]
    || result.stdout.trim().split("\n")[0]
    || `exit=${result.exitCode ?? "unknown"}`;
  throw new Error(`${label} 失败：${reason}`);
}

/**
 * @spec Every resource read checks the borrower's declaration before using the shared native transport.
 * @rule API group and namespace remain authorization boundaries even when the underlying pool is shared.
 * @see {@link cli/docs/plugin.md}
 */
function createKubernetesAccess(
  resourcesForNamespace: (namespace: string) => Promise<NamespaceResources>,
  executorForNamespace: (namespace: string) => Pick<Executor, "exec">,
  defaultNamespace: string,
  signal: AbortSignal,
  capability: CapabilityWithAccess,
  portForward: (
    namespace: string,
    target: Parameters<KubernetesAccess["portForward"]>[0],
  ) => ReturnType<KubernetesAccess["portForward"]>,
  podRelay: (namespace: string, target: Parameters<KubernetesAccess["podRelay"]>[0]) => ReturnType<KubernetesAccess["podRelay"]>,
  readFiles: (namespace: string, ...args: Parameters<KubernetesAccess["readFiles"]>) => ReturnType<KubernetesAccess["readFiles"]>,
): KubernetesAccess {
  const scoped = (namespace: string): KubernetesAccess => {
    const assertDeclared = (verb: string, resource: string, resourceName?: string): void => {
      signal.throwIfAborted();
      const declared = capability.access.kubernetes?.some((need) => (
        need.rule.verb === verb
        && need.rule.resource === resource
        && (need.rule.resourceName === undefined || need.rule.resourceName === resourceName)
        && (namespace === defaultNamespace || need.rule.allNamespaces === true)
      ));
      if (!declared) {
        throw new Error(`Plugin capability 未声明 Kubernetes access: ${verb} ${resource}`);
      }
    };
    const commandLabel = (command: readonly string[]): string => (
      `kubectl -n ${namespace} ${command.join(" ")}`
    );
    const accessOptions = { signal, timeoutMs: PLUGIN_KUBERNETES_TIMEOUT_MS };
    const accessResource = (query: { apiVersion: string; resource: string }) => {
      const [group] = query.apiVersion.includes("/") ? query.apiVersion.split("/") : [];
      return query.resource + (group ? "." + group : "");
    };
    return {
      inNamespace: (selected) => scoped(selected.trim() || defaultNamespace),
      get: async <T>(ref: KubernetesResourceRef) => {
        assertDeclared("get", accessResource(ref), ref.name);
        return await (await resourcesForNamespace(namespace)).get(ref, accessOptions) as T;
      },
      list: async <T>(query: KubernetesResourceListQuery) => {
        assertDeclared("list", accessResource(query));
        return await (await resourcesForNamespace(namespace)).list(query, accessOptions) as KubernetesResourceList<T>;
      },
      exec: async (target, command, options) => {
        assertDeclared("create", "pods/exec", target.pod);
        return checkedOutput(
          commandLabel(["exec", target.pod]),
          await executorForNamespace(namespace).exec(target, [...command], {
            signal,
            stdin: options?.stdin,
            timeoutMs: Math.min(options?.timeoutMs ?? PLUGIN_KUBERNETES_TIMEOUT_MS, PLUGIN_KUBERNETES_TIMEOUT_MS),
          }),
        );
      },
      readFiles: async (target, paths, options) => {
        assertDeclared("create", "pods/exec", target.pod);
        return readFiles(namespace, target, paths, { ...options,
          signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal });
      },
      podRelay: async target => {
        // Check every borrower, including when another Service already started the shared relay.
        assertDeclared("list", "pods");
        assertDeclared("create", "pods/exec");
        assertDeclared("create", "pods/portforward");
        return podRelay(namespace, target);
      },
      portForward: async (target) => {
        signal.throwIfAborted();
        assertDeclared("create", "pods/portforward");
        return portForward(namespace, target);
      },
    };
  };
  return scoped(defaultNamespace);
}

/** Create one Doctor-owned context whose resources live for a single capability command. */
export type ManagedPluginContext = PluginContext & { dispose(): Promise<void> };

interface PluginContextOptions {
  signal?: AbortSignal;
  environment: ResolvedKubernetesEnvironment | { readonly kind: "host"; readonly name: string };
  /** An explicitly supplied root owner is useful outside the command async scope. */
  clients?: Pick<ClientManager, "get">;
  config?: Readonly<Record<string, unknown>>;
  /** Inspect-owned observations; every borrower still checks its declared permissions. */
  resources?: KubernetesResourceReader;
  databaseIdentity?: DatabaseIdentity;
  service: ServiceDefinition;
  endpoint?: PluginContext["target"]["endpoint"];
  capability: CapabilityWithAccess;
  dependencies?: Readonly<Record<string, ResolvedServiceDataSourceDependency>>;
}

/** Stable configuration identity stays in memory as a digest; credentials never enter logs or keys. */
function clientNamespace(kube: KubectlOptions, options: PluginContextOptions): string {
  const access = (options.capability.access.kubernetes ?? []).map(need => need.rule)
    .sort((a, b) => clientKey("rule", a).localeCompare(clientKey("rule", b)));
  return clientKey("plugin", {
    kube, environment: options.environment.name, service: options.service.name, endpoint: options.endpoint,
    config: options.config ?? {}, databaseIdentity: options.databaseIdentity, access,
  });
}

export function createPluginContext(
  executor: Executor | undefined,
  kube: KubectlOptions & { namespace: string },
  options: PluginContextOptions,
): ManagedPluginContext {
  if (options.environment.kind === "kubernetes" && kube.context && kube.context !== options.environment.context) throw new Error("Kubernetes context 与已解析的 Environment 不一致");
  // Caller config may carry profile/source annotations; only actual access parameters enter reuse identity.
  kube = { namespace: kube.namespace, kubeconfig: kube.kubeconfig, context: options.environment.kind === "kubernetes" ? options.environment.context : undefined };
  const controller = new AbortController();
  const parentSignal = options.signal ?? currentCommandSignal();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  const root = options.clients ?? currentCommandClients();
  const local = root ? undefined : new ClientManager(parentSignal);
  const clients = root ?? local!;
  const namespace = clientNamespace(kube, options);
  const clusterSource = kubernetesClientSource(kube, executor);
  const cluster = () => {
    if (options.environment.kind !== "kubernetes" || !executor) throw new Error("This Extension context has no Kubernetes target");
    return clients.get(clusterSource);
  };
  const relay = (ns: string) => sharedPodRelay(clients, { ...kube, namespace: ns },
    ns === kube.namespace ? executor : new KubectlExecutor({ ...kube, namespace: ns }));
  const disposers: Array<() => void | Promise<void>> = [];
  let disposal: Promise<void> | undefined;
  const access = (accessSignal: AbortSignal, client?: KubernetesClient): PluginClientContext => ({
    target: { env: options.environment.name, namespace: kube.namespace, service: bindService(options.service, options.environment), endpoint: options.endpoint },
    config: options.config ?? {},
    infra: {
      databaseIdentity: options.databaseIdentity,
      kubernetes: createKubernetesAccess(async ns => options.resources
        ? capturedResourceAccess(options.resources, ns) : (client ?? await cluster()).inNamespace(ns), ns => ({
        exec: async (target, command, runOptions) => (client ?? await cluster()).exec(ns, target, command, runOptions),
      }), kube.namespace, accessSignal, options.capability, async (ns, target) => (client ?? await cluster()).forward(ns, target),
      async (ns, target) => (await relay(ns)).connect(target),
      async (namespace, target, paths, limits) => {
        const file = await clients.get(new PodFileDataSource(clusterSource, { namespace, ...target }, paths, { concurrency: 4 }));
        return file.read(limits);
      }),
    },
    signal: accessSignal,
  });
  const dispose = () => disposal ??= (async () => {
    unregister();
    controller.abort();
    const errors: unknown[] = [];
    for (const close of disposers.reverse()) { try { await close(); } catch (error) { errors.push(error); } }
    try { await local?.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Plugin resource cleanup failed");
  })();
  const unregister = onCommandDispose(dispose);
  return {
    ...access(signal),
    dependencies: options.dependencies ?? {},
    clients: {
      get: async source => {
        signal.throwIfAborted();
        // Acquire dependencies first; finalization then closes consumers before Kubernetes transports.
        const kubernetes = options.environment.kind === "kubernetes" ? await cluster() : undefined;
        signal.throwIfAborted();
        return clients.get({
          clientKey: `${namespace}:${source.clientKey}`,
          createClient: (_clients, rootSignal) => source.createClient(access(rootSignal, kubernetes)),
        });
      },
    },
    onDispose: disposer => disposers.push(disposer),
    dispose,
  };
}

/** Check declarations only; prepare must not execute capability code or initialize clients. */
export async function preflightPluginAccess(
  authorization: KubernetesAccessContext,
  command: string,
  namespace: string,
  capability: CapabilityWithAccess,
): Promise<void> {
  await enforceKubernetesAccess(authorization, { command, namespace, needs: capabilityAccessNeeds(capability) });
}

/** Authorize the selected capability before exposing its target-scoped transport. */
export async function openPluginContext(
  executor: Executor,
  kube: KubectlOptions & { namespace: string },
  options: Omit<PluginContextOptions, "environment"> & {
    environment?: ResolvedKubernetesEnvironment;
    command: string;
    authorization: KubernetesAccessContext;
  },
): Promise<ManagedPluginContext> {
  await preflightPluginAccess(options.authorization, `${options.command} · ${options.service.name}`, kube.namespace, options.capability);
  const environment = options.environment ?? await resolveKubernetesEnvironment(executor);
  return createPluginContext(executor, bindKubernetesEnvironment(kube, environment), { ...options, environment });
}

/** Host-only providers still use the common access, client ownership and disposal machinery. */
export function createHostPluginContext(
  options: Omit<PluginContextOptions, "environment"> & { namespace?: string },
): ManagedPluginContext {
  if (options.capability.access.kubernetes?.length) {
    throw new Error("Host Extension context cannot grant Kubernetes access");
  }
  return createPluginContext(undefined, { namespace: options.namespace ?? "" }, {
    ...options, environment: { kind: "host", name: clientKey("doctor-host", hostname()) },
  });
}
