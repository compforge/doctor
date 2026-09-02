import type { ExecResult } from "../../../infra/k8s/executor";
import type { Inspect } from "../../inspection";
import type { LogCommandContext, LogInspectionFacts } from "../model";
import { collectedFact, failedFact, unavailableFact } from "../../protocol";

function failureReason(result: ExecResult): string {
  return result.stderr.trim().split("\n")[0] || `exit=${result.exitCode}`;
}

function record(
  ctx: LogCommandContext,
  id: string,
  title: string,
  result: ExecResult,
): void {
  ctx.bundle.addStep({
    id,
    title,
    risk: "observe",
    status: result.ok ? "ok" : "failed",
    reason: result.ok ? undefined : failureReason(result),
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    output: result.stdout,
    stderr: result.stderr,
  });
}

export function makeLogInspect(
  services: readonly string[],
): Inspect<LogInspectionFacts, LogCommandContext> {
  return {
    id: "log-target",
    run: async (ctx) => {
      ctx.log("[collect] 预检 kubectl…");
      const version = await ctx.access.clientVersion();
      record(ctx, "kubectl-version", "kubectl 客户端版本", version);
      if (!version.ok) {
        const reason = `kubectl 不可用：${failureReason(version)}`;
        return {
          runtime: failedFact("log.runtime", "log-target", reason),
          servicePods: unavailableFact("log.service-pods", "log-target", reason),
        };
      }

      const kubectlVersion = version.stdout.split("\n")[0]?.trim() || undefined;
      ctx.log("[collect] 查找目标 namespace 的服务 pod…");
      const podList = await ctx.access.listServicePods(services);
      record(ctx, "service-list", "目标 namespace Service 列表", podList.serviceCapture);
      record(ctx, "pod-list", "目标 namespace Pod 列表", podList.podCapture);
      if (!podList.serviceCapture.ok || !podList.podCapture.ok) {
        const failed = !podList.serviceCapture.ok ? podList.serviceCapture : podList.podCapture;
        return {
          runtime: collectedFact("log.runtime", "log-target", { kubectlVersion }),
          servicePods: failedFact(
            "log.service-pods",
            "log-target",
            `Service/Pod 列表获取失败：${failureReason(failed)}`,
          ),
        };
      }
      if (podList.parseError) {
        const reason = `Pod 列表 JSON 解析失败：${podList.parseError}`;
        ctx.bundle.addStep({
          id: "pod-resolve",
          title: "服务 Pod 解析",
          risk: "observe",
          status: "failed",
          reason,
        });
        return {
          runtime: collectedFact("log.runtime", "log-target", { kubectlVersion }),
          servicePods: failedFact("log.service-pods", "log-target", reason),
        };
      }
      return {
        runtime: collectedFact("log.runtime", "log-target", { kubectlVersion }),
        servicePods: collectedFact("log.service-pods", "log-target", {
          byService: podList.byService,
          containersByPod: Object.fromEntries(podList.pods.map((pod) => [
            pod.name,
            pod.containers.map((container) => container.name),
          ])),
          previousContainersByPod: Object.fromEntries(podList.pods.map((pod) => [
            pod.name,
            pod.containers
              .filter((container) => container.restartCount > 0 && container.hasPreviousTerminated)
              .map((container) => container.name),
          ])),
        }),
      };
    },
  };
}
