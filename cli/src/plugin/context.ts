import { createHash } from "node:crypto";
import { ResourceScope, type ResourceLifetime } from "@compforge/doctor-toolkit/resources";
import { currentCommandResources, currentCommandSignal, onCommandDispose } from "../command/execution-scope";
import type {
  CapabilityWithAccess,
  DatabaseIdentity,
  KubernetesAccess,
  PluginContext,
  PluginResourceContext,
  ResolvedServiceCapabilityDependency,
} from "@compforge/doctor-plugin";
import type {
  KubernetesAccessContext,
  KubernetesAccessNeed,
} from "../infra/k8s/access";
import type {
  ExecResult,
  Executor,
  KubectlOptions,
} from "@compforge/doctor-toolkit/kubernetes/executor";
import { KubectlExecutor } from "@compforge/doctor-toolkit/kubernetes/executor";
import { ServicePortForwarder } from "@compforge/doctor-toolkit/kubernetes/service-port-forward";
import { enforceKubernetesAccess } from "../terminal/kubernetes-access";

const PLUGIN_KUBERNETES_TIMEOUT_MS = 20_000;
const PLUGIN_KUBERNETES_OUTPUT_LIMIT = 4 * 1024 * 1024;

function capabilityAccessNeeds(capability: CapabilityWithAccess): KubernetesAccessNeed[] {
  const needs = [...(capability.access.kubernetes ?? [])];
  const portForward = needs.find((need) => (
    need.rule.verb === "create" && need.rule.resource === "pods/portforward"
  ));
  if (portForward) {
    needs.push({
      rule: { verb: "list", resource: "services" },
      requirement: portForward.requirement,
      purpose: "Core 为 port-forward 解析 Service target",
      fallback: portForward.fallback,
    }, {
      rule: { verb: "list", resource: "pods" },
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

function parseJson<T>(label: string, output: string): T {
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} 返回了无效 JSON：${detail}`, { cause: error });
  }
}

function createKubernetesAccess(
  executorForNamespace: (namespace: string) => Executor,
  defaultNamespace: string,
  signal: AbortSignal,
  capability: CapabilityWithAccess,
  portForward: (
    namespace: string,
    target: Parameters<KubernetesAccess["portForward"]>[0],
  ) => ReturnType<KubernetesAccess["portForward"]>,
): KubernetesAccess {
  const scoped = (namespace: string): KubernetesAccess => {
    const assertDeclared = (verb: string, resource: string, resourceName?: string): void => {
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
    const run = async (command: readonly string[]): Promise<string> => checkedOutput(
      commandLabel(command),
      await executorForNamespace(namespace).run([...command], {
        signal,
        timeoutMs: PLUGIN_KUBERNETES_TIMEOUT_MS,
      }),
    );
    return {
      inNamespace: (selected) => scoped(selected.trim() || defaultNamespace),
      get: async <T>(resource: string, name: string) => {
        assertDeclared("get", resource, name);
        return parseJson<T>(
          `Kubernetes ${resource}/${name}`,
          await run(["get", resource, name, "-o", "json"]),
        );
      },
      list: async <T>(resource: string, options?: { labelSelector?: string }) => {
        assertDeclared("list", resource);
        const command = ["get", resource];
        if (options?.labelSelector) command.push("-l", options.labelSelector);
        command.push("-o", "json");
        const list = parseJson<{ items?: T[] }>(`Kubernetes ${resource} list`, await run(command));
        return list.items ?? [];
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
  env: string;
  config?: Readonly<Record<string, unknown>>;
  databaseIdentity?: DatabaseIdentity;
  service: PluginContext["target"]["service"];
  endpoint?: PluginContext["target"]["endpoint"];
  capability: CapabilityWithAccess;
  dependencies?: Readonly<Record<string, ResolvedServiceCapabilityDependency>>;
}

/** Stable configuration identity stays in memory as a digest; credentials never enter logs or keys. */
function resourceNamespace(kube: KubectlOptions, options: PluginContextOptions): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
    );
    return value;
  };
  const access = (options.capability.access.kubernetes ?? []).map((need) => canonical(need.rule));
  access.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(canonical({
    kube, env: options.env, service: options.service, endpoint: options.endpoint,
    config: options.config ?? {}, databaseIdentity: options.databaseIdentity, access,
  }))).digest("hex");
}

function createResourceContext(
  executor: Executor,
  kube: KubectlOptions & { namespace: string },
  options: PluginContextOptions,
  lifetime: ResourceLifetime,
): PluginResourceContext {
  const { signal } = lifetime;
  const executors = new Map<string, Executor>([[kube.namespace, executor]]);
  const executorForNamespace = (namespace: string): Executor => {
    let scoped = executors.get(namespace);
    if (!scoped) {
      scoped = new KubectlExecutor({ ...kube, namespace });
      executors.set(namespace, scoped);
    }
    return scoped;
  };
  const forwarders = new Map<string, Promise<ServicePortForwarder>>();
  // Install transport cleanup before clients register theirs, so clients close first.
  lifetime.onDispose(async () => {
    const results = await Promise.allSettled([...forwarders.values()].map(async (pending) => {
      const ready = await pending.catch(() => undefined);
      await ready?.stop();
    }));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Plugin transport cleanup failed");
  });
  const portForward = async (namespace: string, target: Parameters<KubernetesAccess["portForward"]>[0]) => {
    let forwarder = forwarders.get(namespace);
    if (!forwarder) {
      const scopedKube = { ...kube, namespace };
      forwarder = ServicePortForwarder.create(executorForNamespace(namespace), scopedKube);
      forwarders.set(namespace, forwarder);
      void forwarder.catch(() => { if (forwarders.get(namespace) === forwarder) forwarders.delete(namespace); });
    }
    return await (await forwarder).forward(target);
  };
  return {
    target: {
      env: options.env,
      namespace: kube.namespace,
      service: options.service,
      endpoint: options.endpoint,
    },
    config: options.config ?? {},
    infra: {
      databaseIdentity: options.databaseIdentity,
      kubernetes: createKubernetesAccess(
        executorForNamespace,
        kube.namespace,
        signal,
        options.capability,
        portForward,
      ),
    },
    signal,
    onDispose: (disposer) => lifetime.onDispose(disposer),
  };
}

export function createPluginContext(
  executor: Executor,
  kube: KubectlOptions & { namespace: string },
  options: PluginContextOptions,
): ManagedPluginContext {
  const local = new ResourceScope(currentCommandSignal());
  const shared = currentCommandResources() ?? local;
  const namespace = resourceNamespace(kube, options);
  const unregister = onCommandDispose(() => local.dispose());
  return {
    ...createResourceContext(executor, kube, options, local),
    dependencies: options.dependencies ?? {},
    resources: {
      acquire: (key, create) => {
        local.signal.throwIfAborted();
        return shared.acquire(`${namespace}:${key}`, (lifetime) => create(
          createResourceContext(executor, kube, options, lifetime),
        ));
      },
    },
    dispose: () => { unregister(); return local.dispose(); },
  };
}

/** Authorize the selected capability before exposing its target-scoped transport. */
export async function openPluginContext(
  executor: Executor,
  kube: KubectlOptions & { namespace: string },
  options: PluginContextOptions & {
    command: string;
    authorization: KubernetesAccessContext;
  },
): Promise<ManagedPluginContext> {
  await enforceKubernetesAccess(options.authorization, {
    command: `${options.command} · ${options.service.name}`,
    namespace: kube.namespace,
    needs: capabilityAccessNeeds(options.capability),
  });
  return createPluginContext(executor, kube, options);
}
