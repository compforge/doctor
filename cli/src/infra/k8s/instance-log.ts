import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { KubernetesPodLogAccess, PodLogResult } from "@compforge/harness-toolbox/kubernetes/pod-log";
import { currentCommandSignal } from "../../command/execution-scope";

/**
 * @rule Discovery identity is not a read precondition in Kubernetes' log API. Check both boundaries.
 * @why These checks detect replacements; they do not promise an atomic snapshot across the stream.
 * Failed verification retains raw evidence as unavailable, never as verified instance logs.
 */
export function instanceLogAccess(access: KubernetesPodLogAccess, executor: Executor,
  expected: { pod: string; uid: string; container: string; instance?: string; previous?: boolean },
  signal = currentCommandSignal(),
): KubernetesPodLogAccess {
  const verify = async () => {
    const result = await executor.run(["get", "pods", expected.pod, "-o", "json"],
      { timeoutMs: 10_000, signal });
    if (!result.ok) throw new Error(`Pod '${expected.pod}' 身份校验失败：${result.stderr.trim() || "get Pod failed"}`);
    const pod = JSON.parse(result.stdout) as {
      metadata?: { uid?: string };
      status?: { containerStatuses?: { name: string; containerID?: string; lastState?: { terminated?: { containerID?: string } } }[] };
    };
    if (pod.metadata?.uid !== expected.uid) throw new Error(`Pod '${expected.pod}' UID 已变化，日志不能归属到发现时的实例`);
    if (expected.instance) {
      const container = pod.status?.containerStatuses?.find(item => item.name === expected.container);
      const id = expected.previous ? container?.lastState?.terminated?.containerID : container?.containerID;
      if (JSON.stringify([expected.uid, id]) !== expected.instance) {
        throw new Error(`Pod '${expected.pod}/${expected.container}' Container 实例已变化或无法验证`);
      }
    }
  };
  return {
    clientVersion: () => access.clientVersion(),
    listServicePods: services => access.listServicePods(services),
    collectPodLogs: async request => {
      let captured: PodLogResult | undefined;
      try {
        await verify();
        captured = await access.collectPodLogs(request);
        await verify();
        if (!expected.instance && captured.captureStatus === "complete") {
          const reason = "Pod UID 已校验，但运行时 Container 身份未验证";
          return { ...captured, captureStatus: "partial", reason, stderr: reason };
        }
        return captured;
      } catch (error) {
        signal?.throwIfAborted();
        const reason = error instanceof Error ? error.message : String(error);
        return { command: ["get", "pods", expected.pod], stdout: "", durationMs: 0, timedOut: false,
          bytesRead: 0, attempts: 0, ...captured, ok: false, exitCode: 1, captureStatus: "unavailable", stderr: reason, reason };
      }
    },
  };
}
