import type {
  CapabilityWithAccess,
  DatabaseIdentity,
  KubernetesAccess,
  PluginContext,
} from "@compforge/doctor-plugin";
import type {
  KubernetesAccessContext,
  KubernetesAccessNeed,
} from "../infra/k8s/access";
import type {
  ExecResult,
  Executor,
  KubectlOptions,
} from "../infra/k8s/executor";
import { ServicePortForwarder } from "../infra/k8s/service-port-forward";
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
    throw new Error(`${label} 返回了无效 JSON：${detail}`);
  }
}

function createKubernetesAccess(
  executor: Executor,
  signal: AbortSignal,
  capability: CapabilityWithAccess,
  portForward: PluginContext["infra"]["kubernetes"]["portForward"],
): KubernetesAccess {
  const assertDeclared = (verb: string, resource: string, resourceName?: string): void => {
    const declared = capability.access.kubernetes?.some((need) => (
      need.rule.verb === verb
      && need.rule.resource === resource
      && (need.rule.resourceName === undefined || need.rule.resourceName === resourceName)
    ));
    if (!declared) {
      throw new Error(`Plugin capability 未声明 Kubernetes access: ${verb} ${resource}`);
    }
  };
  const run = async (command: readonly string[]): Promise<string> => checkedOutput(
    `kubectl ${command.join(" ")}`,
    await executor.run([...command], { signal, timeoutMs: PLUGIN_KUBERNETES_TIMEOUT_MS }),
  );
  return {
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
    exec: async (target, command) => {
      assertDeclared("create", "pods/exec", target.pod);
      return checkedOutput(
        `kubectl exec ${target.pod} -- ${command.join(" ")}`,
        await executor.exec(target, [...command], {
          signal,
          timeoutMs: PLUGIN_KUBERNETES_TIMEOUT_MS,
        }),
      );
    },
    portForward: async (target) => {
      assertDeclared("create", "pods/portforward");
      return portForward(target);
    },
  };
}

/** Create one Doctor-owned context whose resources live for a single capability command. */
export type ManagedPluginContext = PluginContext & { dispose(): Promise<void> };

interface PluginContextOptions {
  env: string;
  config?: Readonly<Record<string, unknown>>;
  databaseIdentity?: DatabaseIdentity;
  service: PluginContext["target"]["service"];
  capability: CapabilityWithAccess;
}

export function createPluginContext(
  executor: Executor,
  kube: KubectlOptions & { namespace: string },
  options: PluginContextOptions,
): ManagedPluginContext {
  const controller = new AbortController();
  const disposers: Array<() => void | Promise<void>> = [];
  let forwarder: Promise<ServicePortForwarder> | undefined;
  const portForward: PluginContext["infra"]["kubernetes"]["portForward"] = async (target) => {
    forwarder ??= ServicePortForwarder.create(executor, kube);
    return await (await forwarder).forward(target);
  };
  const context: ManagedPluginContext = {
    target: {
      env: options.env,
      namespace: kube.namespace,
      service: options.service,
    },
    config: options.config ?? {},
    infra: {
      databaseIdentity: options.databaseIdentity,
      kubernetes: createKubernetesAccess(
        executor,
        controller.signal,
        options.capability,
        portForward,
      ),
    },
    signal: controller.signal,
    onDispose: (disposer) => disposers.push(disposer),
    dispose: async () => {
      controller.abort();
      const settled = await Promise.allSettled(disposers.reverse().map((dispose) => dispose()));
      (await forwarder)?.stop();
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
  return context;
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
    needs: capabilityAccessNeeds(options.capability),
  });
  return createPluginContext(executor, kube, options);
}
