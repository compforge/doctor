import { withSummary, type WorkloadInstance } from "@compforge/doctor-plugin";
import type { Endpoint, Workload } from "@compforge/harness-common";
import { validateEndpoint } from "@compforge/harness-toolbox/endpoint";
import { probeConnectivity, type ConnectivityResult } from "@compforge/harness-toolbox/network";
import { ToolboxError } from "@compforge/harness-toolbox/errors";
import type { Executor, KubectlOptions } from "@compforge/harness-toolbox/kubernetes/executor";
import type { CommandContext } from "../../command";
import type { HealthProvider } from "../extensions";
import { discoverHealthWorkload } from "../workloads";
import { caseOperationInvoker } from "../runtime";
import { useLogger } from "../../terminal/log";

export interface HealthEndpointCheck {
  source: string;
  workload?: string;
  instance?: WorkloadInstance;
  endpoint?: Endpoint;
  status: "passed" | "failed" | "none" | "unavailable" | "not-run" | "cancelled";
  evidence?: ConnectivityResult;
  reason?: string;
  error?: { message: string; kind?: string; code?: string | number };
}

/** @spec Explicit [] confirms no outbound dependencies; missing execution location preserves unknown coverage. */
export async function checkHealthEndpoints(provider: HealthProvider, context: CommandContext, executor: Executor,
  kubernetes: KubectlOptions & { namespace: string }): Promise<HealthEndpointCheck[]> {
  if (provider.endpoints === undefined) return [];
  if (!provider.endpoints.length) {
    useLogger("health").info(`${provider.name}: 没有对外 Endpoint 依赖`);
    return [{ source: provider.name, status: "none" }];
  }
  const results: HealthEndpointCheck[] = [];
  const invoke = caseOperationInvoker(context, executor, kubernetes);
  // @why Several addresses may share a consumer; discover its instances once per check.
  const discoveries = new Map<Workload, ReturnType<typeof discoverHealthWorkload>>();
  const unavailable = (base: Pick<HealthEndpointCheck, "source" | "workload" | "instance" | "endpoint">, error: unknown) => {
    const detail = { message: error instanceof Error ? error.message : String(error),
      ...(error instanceof ToolboxError ? { kind: error.kind, code: error.code } : {}) };
    results.push({ ...base, status: context.signal.aborted ? "cancelled" : "unavailable", error: detail });
    useLogger("health").info(`Endpoint ${provider.name}/${base.source}: 未取得证据 · ${detail.message}`);
  };
  if (provider.endpoints.length > 100) unavailable({ source: provider.name }, new Error(`仅探测 ${provider.endpoints.length} 个地址中的前 100 个`));
  for (const endpoint of provider.endpoints.slice(0, 100)) {
    const base = { source: endpoint.id ?? `${endpoint.host}:${endpoint.port}`, workload: endpoint.workload?.name, endpoint };
    if (context.signal.aborted) {
      results.push({ ...base, status: "not-run", reason: "执行前已取消" });
      continue;
    }
    try {
      validateEndpoint(endpoint);
      if (!endpoint.workload) throw new Error("未声明消费方 Workload，无法确定 Endpoint 探测位置");
      let discovery = discoveries.get(endpoint.workload);
      if (!discovery) {
        discovery = discoverHealthWorkload(endpoint.workload, context, executor, kubernetes);
        discoveries.set(endpoint.workload, discovery);
      }
      const discovered = await discovery;
      const running = discovered.instances.filter(found => discovered.pods.some(pod => pod.name === found.pod && pod.phase === "Running"));
      if (running.length > 10) unavailable(base, new Error(`仅探测 ${running.length} 个运行实例中的前 10 个`));
      const selected = new Set(running.slice(0, 10));
      for (const found of discovered.instances) {
        const pod = discovered.pods.find(pod => pod.name === found.pod);
        const instance = { ...found, container: found.container ?? (pod?.containers.length === 1 ? pod.containers[0]!.name : undefined) };
        const consumer = { ...base, instance };
        if (context.signal.aborted || !selected.has(found)) {
          const reason = context.signal.aborted ? "执行前已取消"
            : pod?.phase !== "Running" ? `Pod 状态 ${pod?.phase ?? "未知"}，无法执行通用 exec 探测` : "超出本轮 10 个运行实例探测上限";
          results.push({ ...consumer, status: "not-run", reason });
          useLogger("health").info(`Endpoint ${provider.name}/${base.source}/${instance.pod}: 未执行 · ${reason}`);
          continue;
        }
        try {
          if (!instance.container) throw new Error("无法确定消费方 Container，不能判断 Endpoint 连通性");
          useLogger("health").info(`探测 Endpoint ${provider.name}/${base.source}/${instance.pod} → ${endpoint.host}:${endpoint.port}`);
          const evidence = await invoke(provider.service, {
            access: { kubernetes: [{ requirement: "required", rule: { verb: "create", resource: "pods/exec" }, purpose: "从消费方实例探测 Endpoint" }] },
            run: withSummary({ title: "Endpoint connectivity", fields: [] }, async plugin => probeConnectivity(endpoint,
              (command, options) => plugin.infra.kubernetes.exec({ pod: instance.pod, container: instance.container }, command, options),
              { timeoutMs: 5000, signal: context.signal })),
          }, {});
          results.push({ ...consumer, status: evidence.status, evidence });
          useLogger("health").info(`Endpoint ${provider.name}/${base.source}/${instance.pod}: ${evidence.status}`);
        } catch (error) { unavailable(consumer, error); }
      }
      if (!running.length && !context.signal.aborted) unavailable(base, new Error("没有可执行通用 Endpoint 探测的 Running Pod"));
    } catch (error) { unavailable(base, error); }
  }
  return results;
}
