import type { HealthInteraction } from "../interaction";
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
  status: "passed" | "failed" | "none" | "unavailable" | "not-run" | "cancelled" | "skipped";
  evidence?: ConnectivityResult;
  reason?: string;
  error?: { message: string; kind?: string; code?: string | number };
}

/** @spec Explicit [] confirms no outbound dependencies; missing execution location preserves unknown coverage.
 * @spec Each Endpoint is checked once from its Workload's first Running instance; the remaining replicas are outside this sample.
 * @see {@link component://docs/commands/health.md} */
export async function checkHealthEndpoints(provider: HealthProvider, context: CommandContext, executor: Executor,
  kubernetes: KubectlOptions & { namespace: string }, interaction?: HealthInteraction): Promise<HealthEndpointCheck[]> {
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
    useLogger("health").warn(`Endpoint ${provider.name}/${base.source}: 未取得证据 · ${detail.message}`);
  };
  for (const [index, endpoint] of provider.endpoints.entries()) {
    const base = { source: endpoint.id ?? `${endpoint.host}:${endpoint.port}`, workload: endpoint.workload?.name, endpoint };
    if (context.signal.aborted || interaction?.stopped || index >= 100) {
      const reason = context.signal.aborted ? "执行前已取消" : interaction?.stopped ? "用户结束巡检" : "超出本轮 100 个地址探测上限";
      results.push({ ...base, status: "not-run", reason });
      useLogger("health").info(`Endpoint ${provider.name}/${base.source}: 未执行 · ${reason}`);
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
      for (const found of running.slice(0, 1)) {
        const pod = discovered.pods.find(pod => pod.name === found.pod);
        const instance = { ...found, container: found.container ?? (pod?.containers.length === 1 ? pod.containers[0]!.name : undefined) };
        const consumer = { ...base, instance };
        if (context.signal.aborted) {
          results.push({ ...consumer, status: "not-run", reason: "执行前已取消" });
          continue;
        }
        try {
          if (!instance.container) throw new Error("无法确定消费方 Container，不能判断 Endpoint 连通性");
          if (interaction) {
            const decision = await interaction.approve({ id: `health-endpoint-${base.source}`, risk: "observe",
              title: `Endpoint 连通性：${base.source}`, target: `${endpoint.host}:${endpoint.port}`,
              impact: [`从 ${provider.name} / ${instance.pod}/${instance.container} 检查 DNS、TCP 与受支持的 TLS，限时 5 秒。`],
            });
            if (!decision.approved) {
              results.push({ ...consumer, status: context.signal.aborted ? "cancelled" : interaction.stopped ? "not-run" : "skipped",
                reason: interaction.stopped ? "用户结束巡检" : "用户跳过 Endpoint 检查" });
              continue;
            }
          }
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
