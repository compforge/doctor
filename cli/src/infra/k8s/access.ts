import type { ExecResult, Executor } from "./executor";
import type {
  KubernetesAccessNeed,
  KubernetesAccessRule,
  KubernetesAccessRequirement,
} from "@compforge/doctor-plugin";

export type {
  KubernetesAccessNeed,
  KubernetesAccessRule,
  KubernetesAccessRequirement,
} from "@compforge/doctor-plugin";

export type K8sAccessStatus = "allowed" | "denied" | "unknown";

export type K8sAccessRule = KubernetesAccessRule;

export interface KubernetesAccessContract {
  command: string;
  needs: readonly KubernetesAccessNeed[];
}

export interface KubernetesAccessFact {
  need: KubernetesAccessNeed;
  status: K8sAccessStatus;
  result: ExecResult;
}

export interface KubernetesAccessEvaluation {
  command: string;
  facts: KubernetesAccessFact[];
  runnable: boolean;
}

export interface KubernetesChannelFact {
  available: boolean;
  client: ExecResult;
  server?: ExecResult;
  reason?: string;
}

function accessKey(rule: K8sAccessRule): string {
  return `${rule.verb}:${rule.resource}:${rule.resourceName ?? ""}:${rule.allNamespaces ? "all" : ""}`;
}

function detail(result: ExecResult): string {
  return result.stderr.trim().split("\n")[0]
    || result.stdout.trim().split("\n")[0]
    || `exit=${result.exitCode ?? "unknown"}`;
}

export function accessLabel(rule: K8sAccessRule): string {
  return `${rule.verb} ${rule.resource}${rule.resourceName ? `/${rule.resourceName}` : ""}`
    + `${rule.allNamespaces ? " (all namespaces)" : ""}`;
}

/** `yes` / `no` are authoritative; transport, authentication and SSAR failures remain unknown. */
export async function inspectK8sAccess(
  exec: Executor,
  access: K8sAccessRule,
): Promise<{ status: K8sAccessStatus; result: ExecResult }> {
  const args = ["auth", "can-i", access.verb, access.resource];
  if (access.resourceName) args.push(`--resource-name=${access.resourceName}`);
  if (access.allNamespaces) args.push("--all-namespaces");
  let result: ExecResult;
  try {
    result = await exec.run(args, { timeoutMs: 15_000 });
  } catch (error) {
    // Executor adapter 抛错只说明 preflight 没跑通，不能据此伪造 RBAC 拒绝。
    result = {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: 0,
      timedOut: false,
      command: args,
    };
  }
  const answer = result.stdout.trim().toLowerCase();
  const status = answer.startsWith("yes")
    ? "allowed"
    : answer.startsWith("no")
      ? "denied"
      : "unknown";
  return { status, result };
}

/**
 * Command-scoped Kubernetes permission facts.
 * Interactive stages consume this context to choose discovery or manual-input routes.
 */
export class KubernetesAccessContext {
  readonly #cache = new Map<string, Promise<{ status: K8sAccessStatus; result: ExecResult }>>();
  readonly #facts = new Map<string, KubernetesAccessFact>();

  constructor(private readonly executor: Executor) {}

  inspect(rule: K8sAccessRule): Promise<{ status: K8sAccessStatus; result: ExecResult }> {
    const key = accessKey(rule);
    let pending = this.#cache.get(key);
    if (!pending) {
      pending = inspectK8sAccess(this.executor, rule);
      this.#cache.set(key, pending);
    }
    return pending;
  }

  async evaluate(contract: KubernetesAccessContract): Promise<KubernetesAccessEvaluation> {
    const facts = await Promise.all(contract.needs.map(async (need): Promise<KubernetesAccessFact> => {
      const fact = { need, ...await this.inspect(need.rule) };
      this.#facts.set(accessKey(need.rule), fact);
      return fact;
    }));
    return {
      command: contract.command,
      facts,
      runnable: facts.every(
        (fact) => fact.need.requirement !== "required" || fact.status !== "denied",
      ),
    };
  }

  fact(rule: K8sAccessRule): KubernetesAccessFact | undefined {
    return this.#facts.get(accessKey(rule));
  }

  allowed(rule: K8sAccessRule): boolean {
    return this.fact(rule)?.status === "allowed";
  }
}

export interface KubernetesCommandContext {
  executor: Executor;
  access: KubernetesAccessContext;
}

export function createKubernetesCommandContext(executor: Executor): KubernetesCommandContext {
  return {
    executor,
    access: new KubernetesAccessContext(executor),
  };
}

/**
 * Validate the Doctor Host transport before namespace/resource discovery.
 * A forbidden `/version` still proves the kubeconfig reached an authenticated API Server.
 */
export async function inspectKubernetesChannel(executor: Executor): Promise<KubernetesChannelFact> {
  const client = await executor.run(["version", "--client", "-o", "json"], { timeoutMs: 15_000 });
  if (!client.ok) {
    return { available: false, client, reason: `kubectl client 不可用：${detail(client)}` };
  }
  const server = await executor.run(["get", "--raw=/version"], { timeoutMs: 15_000 });
  if (server.ok || /\bforbidden\b/i.test(server.stderr)) {
    return { available: true, client, server };
  }
  return {
    available: false,
    client,
    server,
    reason: `无法通过当前 kubeconfig 访问 Kubernetes API Server：${detail(server)}`,
  };
}
