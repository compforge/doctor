import type { KubernetesWorkloadEnvironmentProbe } from "@compforge/doctor-plugin";
import { currentCommandSignal } from "../../../command/execution-scope";
import { PROBE_RUNNABLE, probeUnavailable, type Probe } from "../../protocol";
import type { InspectCommandContext, InspectConfig, InspectFacts, InspectObservation, WorkloadEnvironmentObservation } from "../model";

const IP_FORWARD_PATH = "/proc/sys/net/ipv4/ip_forward";
const TIMEOUT_MS = 5_000;
const NODE_FIELDS = ["operatingSystem", "osImage", "kernelVersion", "architecture"] as const;

function target(facts: InspectFacts, service: string, workload: string) {
  if (facts.serviceTargets.status !== "collected") return;
  const runtime = facts.serviceTargets.services[service]?.workloads[workload]?.podRuntime;
  if (runtime?.status !== "collected") return;
  return runtime.pods.filter(pod => pod.phase === "Running" && pod.environmentContainer
    && pod.containers.some(container => container.name === pod.environmentContainer && container.state?.kind === "running"))
    .sort((left, right) => left.pod.localeCompare(right.pod))[0];
}

/**
 * @spec Sample exactly one running Pod from the declared Workload and only its Node; do not enumerate Nodes.
 * @rule Pod ip_forward never establishes the host network namespace setting. Node OS comes from nodeInfo, not the image.
 * @see {@link cli/docs/commands/inspect.md}
 */
export function makeWorkloadEnvironmentProbe(service: string, declaration: KubernetesWorkloadEnvironmentProbe): Probe<InspectObservation, InspectFacts, InspectConfig, InspectCommandContext> {
  const id = `environment-probe-${service}-${declaration.id}`;
  const title = `${service}/${declaration.workload} · Workload environment`;
  const unavailable = (ctx: InspectCommandContext, reason: string) => ctx.bundle.addStep({ id, title, risk: "observe", status: "unavailable", reason });
  return {
    id,
    evaluate: facts => target(facts, service, declaration.workload) ? PROBE_RUNNABLE
      : probeUnavailable(`${service}/${declaration.workload} 没有目标 Container 已运行的 Pod`),
    onUnavailable: unavailable,
    onFailed: unavailable,
    run: async (ctx, facts, config) => {
      const pod = target(facts, service, declaration.workload);
      if (!pod?.environmentContainer) return [];
      const signal = currentCommandSignal() ?? ctx.command.signal;
      signal.throwIfAborted();
      const observation: WorkloadEnvironmentObservation = {
        id, kind: "kubernetes-workload-environment", schemaVersion: 1,
        producer: { origin: "core", id: declaration.kind }, service, workload: declaration.workload, probe: declaration.id,
        instance: pod.instance, namespace: config.namespace, pod: pod.pod, container: pod.environmentContainer,
        nodeName: pod.nodeName, observedAt: new Date().toISOString(), status: "unavailable", nodeInfo: {},
      };
      const reasons: string[] = [];
      ctx.log(`[inspect] ${title}: Pod=${pod.pod}, Container=${pod.environmentContainer}, Node=${pod.nodeName ?? "unknown"}`);
      try {
        const access = await ctx.authorization.inspect({ verb: "get", resource: "pods/exec" }, config.namespace);
        signal.throwIfAborted();
        if (access.status === "denied") throw new Error("缺少 pods/exec 权限");
        const result = await ctx.exec({ pod: pod.pod, container: pod.environmentContainer }, ["cat", IP_FORWARD_PATH], { timeoutMs: TIMEOUT_MS, signal });
        signal.throwIfAborted();
        if (!result.ok) throw new Error(result.timedOut ? "读取超时（5s）" : result.stderr.trim() || `cat 退出码 ${result.exitCode}`);
        const value = result.stdout.trim();
        if (value !== "0" && value !== "1") throw new Error("返回值不是 0 或 1");
        observation.podIpForward = value === "1" ? 1 : 0;
      } catch (error) {
        signal.throwIfAborted();
        reasons.push(`Pod ip_forward: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        if (!pod.nodeName) throw new Error("Pod 未提供 spec.nodeName");
        const access = await ctx.authorization.inspect({ verb: "get", resource: "nodes", resourceName: pod.nodeName });
        signal.throwIfAborted();
        if (access.status === "denied") throw new Error(`缺少 nodes/${pod.nodeName} get 权限`);
        const capture = await ctx.resources({ apiVersion: "v1", resource: "nodes", name: pod.nodeName }, { timeoutMs: TIMEOUT_MS, signal });
        signal.throwIfAborted();
        if (capture.error || !capture.value) throw new Error(capture.error ?? "Node 响应缺失");
        const info = (capture.value as { status?: { nodeInfo?: Record<string, unknown> } }).status?.nodeInfo;
        for (const field of NODE_FIELDS) {
          const value = info?.[field];
          if (typeof value === "string" && value.trim()) observation.nodeInfo[field] = value;
          else reasons.push(`Node status.nodeInfo.${field} 缺失`);
        }
      } catch (error) {
        signal.throwIfAborted();
        reasons.push(`Node: ${error instanceof Error ? error.message : String(error)}`);
      }
      const acquired = observation.podIpForward !== undefined || Object.keys(observation.nodeInfo).length > 0;
      observation.status = !reasons.length ? "ok" : acquired ? "partial" : "unavailable";
      if (reasons.length) observation.reason = reasons.join("；");
      ctx.log(`[inspect] ${title}: ${observation.status}${observation.reason ? ` · ${observation.reason}` : ""}`);
      ctx.bundle.addStep({ id, title, risk: "observe", status: observation.status, reason: observation.reason,
        output: JSON.stringify(observation, null, 2), ext: "json" });
      return [observation];
    },
  };
}
