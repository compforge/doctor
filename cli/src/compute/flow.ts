import type { PluginDefinition, ServiceDefinition, WorkloadInstance } from "@compforge/doctor-plugin";
import { ToolboxError, KubernetesError } from "@compforge/harness-toolbox/errors";
import { collectClusterCompute, collectWorkloadCompute, type ClusterCompute, type WorkloadCompute,
  type ComputeIssue, type ComputeOptions } from "@compforge/harness-toolbox/kubernetes/compute";
import type { ResourceAccess, Resource } from "@compforge/harness-toolbox/kubernetes/resources";
import { resolveWorkload } from "@compforge/harness-toolbox/kubernetes/workload";
import { CommandInputError, CommandStatus } from "../command";

export interface ComputeDiscovery {
  workload: string;
  namespace: string;
  instances: number;
  issues: ComputeIssue[];
}
export interface ServiceCompute {
  service: string;
  discovery: ComputeDiscovery[];
  compute?: WorkloadCompute;
}
export interface ComputeResult {
  environment: string;
  namespace: string;
  startedAt: string;
  complete: boolean;
  cluster?: ClusterCompute;
  services: ServiceCompute[];
}

export function computeServices(plugin: PluginDefinition | undefined, names?: readonly string[]): ServiceDefinition[] {
  if (names?.length === 0 || names?.some(name => !name.trim())) throw new CommandInputError("--service 不能为空");
  if (!names) return [...(plugin?.services.services ?? [])];
  return [...new Set(names.map(name => {
    const service = plugin?.services.find(name.trim());
    if (!service) throw new CommandInputError(`未知 Service '${name}'；请检查已加载的 Plugin`);
    return service;
  }))];
}

function computeIssue(source: string, error: unknown): ComputeIssue {
  const known = error instanceof ToolboxError;
  return { source, kind: known ? error.kind : "operation_failed", code: known ? error.code : undefined,
    message: known && error.kind === "permission_denied" ? "无权限" : "Workload 发现失败" };
}

/**
 * @spec Discovery coverage remains independent of successful Pod reads; an empty failed discovery is not zero Pods.
 * @why Toolbox resolves selectors and identity; this command owns pagination and its per-Service observation budget.
 */
async function discoverService(access: ResourceAccess, service: ServiceDefinition, namespace: string,
  options: ComputeOptions): Promise<{ discovery: ComputeDiscovery[]; instances: WorkloadInstance[]; remaining: number }> {
  const deadline = performance.now() + options.timeoutMs;
  const request = () => {
    options.signal?.throwIfAborted();
    const timeoutMs = Math.ceil(deadline - performance.now());
    if (timeoutMs <= 0) throw new KubernetesError("Compute discovery budget exhausted", { kind: "timeout" });
    return { signal: options.signal, timeoutMs };
  };
  const discovery: ComputeDiscovery[] = [], instances: WorkloadInstance[] = [];
  for (const workload of service.workloads) {
    const ns = workload.namespace ?? namespace;
    const evidence: ComputeDiscovery = { workload: workload.name, namespace: ns, instances: 0, issues: [] };
    discovery.push(evidence);
    const source = `${service.name}/${workload.name}`;
    const bounded: ResourceAccess = {
      get: query => access.get(query, request()),
      list: async query => {
        const items: Resource[] = [], tokens = new Set<string>();
        let continuation: string | undefined;
        try {
          do {
            const page = await access.list({ ...query, limit: Math.min(options.pageSize, options.maxPods - items.length), continue: continuation }, request());
            if (!Array.isArray(page.items)) throw new KubernetesError("Pod list lacks items", { kind: "invalid_response" });
            const remaining = options.maxPods - items.length;
            items.push(...page.items.slice(0, remaining));
            continuation = page.metadata?.continue || undefined;
            if (page.items.length > remaining || (items.length >= options.maxPods && continuation)) {
              evidence.issues.push({ source, kind: "limit_exceeded", message: `Workload 发现最多 ${options.maxPods} 个 Pod` }); break;
            }
            if (continuation && tokens.has(continuation)) throw new KubernetesError("Pagination did not advance", { kind: "invalid_response" });
            if (continuation) tokens.add(continuation);
          } while (continuation);
        } catch (error) {
          options.signal?.throwIfAborted();
          evidence.issues.push(computeIssue(source, error));
        }
        return { items };
      },
    };
    try {
      const found = await resolveWorkload(bounded, workload, ns, options.environment);
      evidence.instances = found.length;
      instances.push(...found);
    } catch (error) {
      options.signal?.throwIfAborted();
      evidence.issues.push(computeIssue(source, error));
    }
  }
  return { discovery, instances, remaining: Math.max(1, Math.ceil(deadline - performance.now())) };
}

/**
 * @spec Cluster and Service scopes are independent; cluster RBAC denial must never block namespace evidence.
 * @spec Service sums are never added into a cluster total: Services may share physical Pods.
 * @link component://docs/commands/compute.md
 */
export async function runCompute(input: {
  access: ResourceAccess; services: readonly ServiceDefinition[]; namespace: string; options: ComputeOptions;
  checkpoint: (result: ComputeResult) => void; progress: (message: string) => void;
}): Promise<ComputeResult> {
  const { access, options, namespace } = input;
  const result: ComputeResult = { environment: options.environment, namespace, startedAt: new Date().toISOString(), complete: false, services: [] };
  input.checkpoint(result);
  input.progress("读取集群容量、Pod requests 和资源指标…");
  result.cluster = await collectClusterCompute(access, options);
  input.checkpoint(result);
  for (const service of input.services) {
    options.signal?.throwIfAborted();
    input.progress(`读取 Service ${service.name} 的 Workload…`);
    const entry: ServiceCompute = { service: service.name, discovery: [] };
    result.services.push(entry);
    if (service.workloads.length) {
      const found = await discoverService(access, service, namespace, options);
      entry.discovery = found.discovery;
      if (found.instances.length || !found.discovery.some(item => item.issues.length)) {
        entry.compute = await collectWorkloadCompute(access, found.instances, { ...options, timeoutMs: found.remaining });
      }
    }
    input.checkpoint(result);
  }
  result.complete = true;
  input.checkpoint(result);
  return result;
}

/** Access restrictions describe coverage, not health. Other acquisition failures remain visible in command status. */
export function computeStatus(result: ComputeResult): CommandStatus {
  if (!result.complete) return CommandStatus.Cancelled;
  const issues = [
    ...[result.cluster?.nodes, result.cluster?.pods, result.cluster?.usage].flatMap(read => read?.issues ?? []),
    ...result.services.flatMap(service => [...service.discovery.flatMap(read => read.issues),
      ...(service.compute?.pods.issues ?? []), ...(service.compute?.usage.issues ?? [])]),
  ];
  return issues.some(issue => issue.kind !== "permission_denied") ? CommandStatus.Partial : CommandStatus.Ok;
}
