import type { ExecResult, Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { Inspect } from "../../inspection";
import type { LogCommandContext, LogInspectionFacts, LogWorkloadTarget } from "../model";
import { collectedFact, failedFact, unavailableFact } from "../../protocol";
import { discoverKubernetesWorkload } from "../../../infra/k8s/workload";

const LOG_TARGET_SCHEMA_VERSION = 2;

function failureReason(result: ExecResult): string {
  return result.stderr.trim().split("\n")[0] || `exit=${result.exitCode}`;
}

/**
 * @spec Service owns Workload locations; Core resolves instances before collecting any logs.
 * @rule A failed or empty declaration is a coverage gap, never a same-name Kubernetes fallback.
 */
export function makeLogInspect(
  services: readonly string[],
  executor: Executor,
): Inspect<LogInspectionFacts, LogCommandContext> {
  return {
    id: "log-target",
    run: async (ctx) => {
      const version = await ctx.access.clientVersion();
      ctx.bundle.addStep({
        id: "kubectl-version", title: "kubectl 客户端版本", risk: "observe",
        status: version.ok ? "ok" : "failed", command: version.command,
        reason: version.ok ? undefined : failureReason(version),
        output: version.stdout, durationMs: version.durationMs,
      });
      if (!version.ok) {
        const reason = `kubectl 不可用：${failureReason(version)}`;
        return {
          runtime: failedFact("log.runtime", "log-target", reason),
          servicePods: { ...unavailableFact("log.service-pods", "log-target", reason), schemaVersion: LOG_TARGET_SCHEMA_VERSION },
        };
      }

      const byService: Record<string, LogWorkloadTarget[]> = {};
      const { environment } = await ctx.command.environment(executor);
      const missing: Record<string, string[]> = {};
      for (const serviceName of services) {
        ctx.command.signal.throwIfAborted();
        const service = ctx.command.plugin.services.findWith(serviceName, "log");
        const targets: LogWorkloadTarget[] = byService[serviceName] = [];
        const gaps: string[] = missing[serviceName] = [];
        if (!service?.workloads.length) {
          gaps.push(`${serviceName}: 未声明可采集日志的 Workload`);
          continue;
        }
        for (const workload of service.workloads) {
          ctx.log(`[collect] 定位 ${serviceName}/${workload.name} 的日志实例…`);
          let captureIndex = 0;
          const resolved = await discoverKubernetesWorkload(
            workload, executor, ctx.config.namespace, environment.name,
            result => ctx.bundle.addStep({
              id: `workload-${serviceName}-${workload.name}-${++captureIndex}`,
              title: `${serviceName}/${workload.name} Workload 定位`,
              risk: "observe", status: result.ok ? "ok" : "failed",
              reason: result.ok ? undefined : failureReason(result),
              command: result.command, durationMs: result.durationMs,
              // Resource specs may contain credentials; only the selected identities enter Facts.
            }),
          );
          ctx.command.signal.throwIfAborted();
          if (resolved.unavailableReason) {
            gaps.push(`${serviceName}/${workload.name}: ${resolved.unavailableReason}`);
            continue;
          }
          const running = resolved.pods.filter(pod => pod.phase === "Running");
          if (!running.length) gaps.push(`${serviceName}/${workload.name}: 没有 Running Pod`);
          for (const pod of running) {
            const instance = resolved.instances.find(instance => instance.pod === pod.name)!;
            const containers = pod.containers.filter(container => !workload.container || container.name === workload.container);
            if (!containers.length) gaps.push(`${serviceName}/${workload.name}/${pod.name}: 没有可读取的 application container${workload.container ? " '" + workload.container + "'" : ""}`);
            for (const container of containers) targets.push({
              instance: { ...instance, container: container.name },
              current: container.containerId ? JSON.stringify([instance.uid, container.containerId]) : undefined,
              previous: container.lastTermination?.containerId
                ? JSON.stringify([instance.uid, container.lastTermination.containerId]) : undefined,
              hasPrevious: container.restartCount > 0 && container.hasPreviousTerminated,
            });
          }
        }
        // Overlapping declarations may observe a replacement during discovery. Do not label
        // logs from a same-name replacement with either stale UID.
        const podUids = new Map<string, string>();
        const changedPods = new Set<string>();
        for (const { instance } of targets) {
          const previous = podUids.get(instance.pod);
          if (previous && previous !== instance.uid) changedPods.add(instance.pod);
          podUids.set(instance.pod, instance.uid);
        }
        if (changedPods.size) {
          byService[serviceName] = targets.filter(target => !changedPods.has(target.instance.pod));
          for (const pod of changedPods) gaps.push(`${serviceName}/${pod}: Workload 定位期间 Pod UID 发生变化，请重试`);
        }
      }
      return {
        runtime: collectedFact("log.runtime", "log-target", { kubectlVersion: version.stdout.split("\n")[0]?.trim() || undefined }),
        servicePods: { ...collectedFact("log.service-pods", "log-target", { byService, missing }), schemaVersion: LOG_TARGET_SCHEMA_VERSION },
      };
    },
  };
}
