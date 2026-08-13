import { infra } from "../../infra";
import { failReason } from "../../infra/k8s/result";
import { approvalDeniedReason } from "../../command/approval";
import { resolveApprovalGate } from "../../terminal/approval";
import { terminalStderr } from "../../terminal/output";
import type { DebugCapability } from "../../infra/target/debug";
import type {
  DebugCliOpts,
  DebugTarget,
  PreparedDebugImage,
} from "./model";
import {
  reportDebugCapabilities,
  reuseReadyDebugEnvironment,
} from "./verify";
import { recordCreatedDebugEnvironment } from "./runtime";

export async function deployDebugEnvironment(
  target: DebugTarget,
  prepared: PreparedDebugImage,
  capabilities: readonly DebugCapability[],
  opts: DebugCliOpts,
  reuseAlreadyChecked = false,
): Promise<number> {
  if (!reuseAlreadyChecked) {
    const existing = await reuseReadyDebugEnvironment(target, capabilities);
    if (existing) return 0;
  }

  const containerName = `doctor-debug-${Date.now().toString(36)}`;
  const image = prepared.image;
  if (!image) return prepared.code;
  const preparation = infra.target.debugEngine.planPreparation(target.executor, {
    namespace: target.namespace,
    podName: target.pod,
    podJson: target.podJson,
    targetContainer: target.container,
    environmentName: containerName,
    image,
    capabilities,
    imagePullPolicy: prepared.imagePullPolicy,
    command: prepared.command,
  });
  const preflight = await preparation.preflight();
  if (!preflight.runnable) {
    terminalStderr.error(
      `[debug] ephemeral container 预检失败：${preflight.reason ?? "原因未知"}\n`,
    );
    return 1;
  }
  const decision = await resolveApprovalGate(opts)({
    id: "debug-container-deploy",
    risk: "disrupt",
    title: "在目标 Pod 启动 doctor debug 临时容器",
    target: `pod/${target.pod} container/${target.container}`,
    impact: [
      prepared.source === "debug-image"
        ? `使用 doctor debug image=${image}`
        : `复用目标业务镜像 ${image}（imagePullPolicy=Never），不访问 registry`,
      `添加临时容器 ${containerName} 并申请 ${capabilities.join("、")}`,
      ...(prepared.source === "target-image"
        ? [`用 ${prepared.command?.[0]} 作为安全常驻命令，不启动业务 ENTRYPOINT/CMD`]
        : []),
      "临时容器记录会保留到 Pod 被替换，不能原地删除或修改",
    ],
  });
  if (!decision.approved) {
    terminalStderr.error(`[debug] ${approvalDeniedReason(decision.source)}\n`);
    return 130;
  }
  const created = await preparation.execute();
  if (!created.ok) {
    terminalStderr.error(`[debug] 创建失败：${failReason(created)}\n`);
    return 1;
  }
  const running = await preparation.waitUntilReady();
  if (!running.ok) {
    terminalStderr.error(`[debug] 容器未就绪：${failReason(running)}\n`);
    return 1;
  }
  recordCreatedDebugEnvironment(target.context, {
    namespace: target.namespace,
    pod: target.pod,
    targetContainer: target.container,
    executionContainer: containerName,
    capabilities,
  });
  await reportDebugCapabilities(target, containerName, capabilities);
  return 0;
}
