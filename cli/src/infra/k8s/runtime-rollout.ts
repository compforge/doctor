import { createHash, randomBytes } from "node:crypto";
import { failReason } from "./result";
import defaultBootstrapSource from "../../../assets/k8s-runtime/bootstrap.py" with { type: "text" };
import { EvidenceBundle, type StepRisk } from "../../collect/evidence";
import type { ApprovalContext } from "../../collect/operation";
import { authorize, type Operation } from "../../collect/operation";
import type { ExecResult, ExecTarget, Executor } from "./executor";
import type { ContainerInfo } from "./target";

const BOOTSTRAP_TIMEOUT_SECONDS = 120;
const POD_WAIT_TIMEOUT_MS = 150_000;
const RUNTIME_ROLLOUT_TIMEOUT_SECONDS = 300;
const UPLOAD_SCRIPT = String.raw`
import hashlib
import os
import sys

path, expected, mode = sys.argv[1:]
os.makedirs(os.path.dirname(path), exist_ok=True)
temporary = path + ".tmp"
digest = hashlib.sha256()
with open(temporary, "wb") as output:
    while True:
        chunk = sys.stdin.buffer.read(1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
        output.write(chunk)
if digest.hexdigest() != expected:
    os.unlink(temporary)
    raise SystemExit("sha256 mismatch")
os.chmod(temporary, int(mode))
os.replace(temporary, path)
`;
const PROCESS_FACTS_SCRIPT = String.raw`
import json
import os
import sys

runtime_dir = sys.argv[1]
os.makedirs(runtime_dir, exist_ok=True)
probe = os.path.join(runtime_dir, ".write-test")
with open(probe, "w", encoding="utf-8") as file:
    file.write("ok")
os.unlink(probe)
os.rmdir(runtime_dir)
try:
    raw_argv = open("/proc/1/cmdline", "rb").read().split(b"\0")
    if raw_argv and raw_argv[-1] == b"":
        raw_argv.pop()
    pid1_argv = [value.decode("utf-8", "replace") for value in raw_argv]
except OSError:
    pid1_argv = []
print(json.dumps({"python": sys.executable, "pid1Argv": pid1_argv}))
`;

export interface RuntimeAsset {
  key: string;
  relativePath: string;
  bytes: Uint8Array;
  mode: number;
  stepId: string;
  title: string;
}

export interface RuntimeRolloutInput extends ApprovalContext {
  exec: Executor;
  podJson: string;
  podName: string;
  container: ContainerInfo;
  log: (line: string) => void;
  notes: string[];
  assets: readonly RuntimeAsset[];
  operation: {
    id: string;
    title: string;
    purpose: string;
    impact: readonly string[];
  };
  capabilities?: readonly string[];
  /** 领域可替换启动 wrapper；缺省版本只负责等待资产，不改变业务进程环境。 */
  bootstrapSource?: string;
}

/**
 * steps 为空：本 operation 被拒时没有属于它自己的工序要记账。py-spy 那份证据的
 * 结论由 collectPySpy 的唯一填格点统一落，不在这里重复标记。
 */
function runtimeRolloutOp(input: RuntimeRolloutInput, deploymentName: string): Operation {
  return {
    id: input.operation.id,
    risk: "disrupt",
    title: input.operation.title,
    target: `deployment/${deploymentName} container/${input.container.name}`,
    impact: [...input.operation.impact],
    steps: [],
  };
}

export interface RuntimeRolloutContext {
  workload: { kind: "Deployment"; name: string };
  podName: string;
  podJson: string;
  target: ExecTarget;
  runtimeDir: string;
  assetPaths: Readonly<Record<string, string>>;
}

export interface RuntimeRolloutResult<T> {
  ok: boolean;
  value?: T;
  reason?: string;
  declined?: boolean;
}

interface WorkloadContainer {
  name: string;
  command?: string[];
  args?: string[];
  startupProbe?: Record<string, unknown>;
  readinessProbe?: Record<string, unknown>;
  livenessProbe?: Record<string, unknown>;
  securityContext?: { capabilities?: { add?: string[] } };
}

interface DeploymentRef {
  name: string;
  raw: string;
  selector: string;
  container: WorkloadContainer;
}

interface ProcessFacts {
  python: string;
  pid1Argv: string[];
}

function record(
  bundle: EvidenceBundle,
  id: string,
  title: string,
  result: ExecResult,
  ext = "txt",
  risk: StepRisk = "disrupt",
): void {
  bundle.addStep({
    id,
    title,
    risk,
    status: result.ok ? "ok" : "failed",
    reason: result.ok ? undefined : failReason(result),
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    output: result.stdout,
    stderr: result.stderr,
    ext,
  });
}

function safeWorkloadPatch(result: ExecResult): ExecResult {
  const command = [...result.command];
  const marker = command.indexOf("--patch");
  if (marker >= 0 && marker + 1 < command.length) {
    command[marker + 1] = "<redacted doctor runtime patch>";
  }
  return { ...result, command };
}

function owner(raw: string): { kind: string; name: string } | undefined {
  const value = JSON.parse(raw) as any;
  const owners = value.metadata?.ownerReferences ?? [];
  const selected = owners.find((item: any) => item.controller === true) ?? owners[0];
  return selected?.kind && selected?.name
    ? { kind: String(selected.kind), name: String(selected.name) }
    : undefined;
}

function selector(raw: string): string | undefined {
  const deployment = JSON.parse(raw) as any;
  const spec = deployment.spec?.selector;
  const parts = Object.entries(spec?.matchLabels ?? {}).map(([key, value]) => `${key}=${String(value)}`);
  for (const expression of spec?.matchExpressions ?? []) {
    const key = String(expression.key ?? "");
    const values = (expression.values ?? []).map(String).join(",");
    if (!key) continue;
    if (expression.operator === "In") parts.push(`${key} in (${values})`);
    else if (expression.operator === "NotIn") parts.push(`${key} notin (${values})`);
    else if (expression.operator === "Exists") parts.push(key);
    else if (expression.operator === "DoesNotExist") parts.push(`!${key}`);
  }
  return parts.length > 0 ? parts.join(",") : undefined;
}

async function resolveDeployment(input: RuntimeRolloutInput): Promise<DeploymentRef> {
  let controller = owner(input.podJson);
  if (!controller) throw new Error("Pod 没有可识别的 controller owner");
  if (controller.kind === "ReplicaSet") {
    const replicaSet = await input.exec.run(["get", "replicaset", controller.name, "-o", "json"], {
      timeoutMs: 20_000,
    });
    record(input.bundle, "runtime-workload-owner", "解析 Pod 控制器", replicaSet, "json", "observe");
    if (!replicaSet.ok) throw new Error(`ReplicaSet 读取失败：${failReason(replicaSet)}`);
    controller = owner(replicaSet.stdout);
  }
  if (controller?.kind !== "Deployment") {
    throw new Error("wrapper rollout 首版仅支持 Deployment，不能保证 StatefulSet/DaemonSet 上传期间旧实例继续服务");
  }
  const workload = await input.exec.run(["get", "deployment", controller.name, "-o", "json"], {
    timeoutMs: 20_000,
  });
  record(input.bundle, "runtime-workload-json", "读取业务 Deployment", workload, "json", "observe");
  if (!workload.ok) throw new Error(`Deployment 读取失败：${failReason(workload)}`);
  const deployment = JSON.parse(workload.stdout) as any;
  if (deployment.spec?.strategy?.type === "Recreate") {
    throw new Error("Deployment 使用 Recreate strategy，不能在 runtime 上传期间保留旧 Pod");
  }
  const maxSurge = deployment.spec?.strategy?.rollingUpdate?.maxSurge ?? "25%";
  if (maxSurge === 0 || maxSurge === "0" || maxSurge === "0%") {
    throw new Error("Deployment maxSurge=0，不能在 runtime 上传期间保留旧 Pod");
  }
  const container = (deployment.spec?.template?.spec?.containers ?? [])
    .find((item: WorkloadContainer) => item.name === input.container.name);
  if (!container) throw new Error(`Deployment 中没有容器 '${input.container.name}'`);
  const workloadSelector = selector(workload.stdout);
  if (!workloadSelector) throw new Error("Deployment selector 为空");
  return { name: controller.name, raw: workload.stdout, selector: workloadSelector, container };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sessionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function widenedStartupProbe(container: WorkloadContainer): Record<string, unknown> | undefined {
  const source = container.startupProbe ?? container.readinessProbe ?? container.livenessProbe;
  if (!source) return undefined;
  const periodSeconds = Number(source.periodSeconds ?? 10);
  const requiredFailures = Math.ceil((BOOTSTRAP_TIMEOUT_SECONDS + 120) / Math.max(periodSeconds, 1));
  return {
    ...source,
    initialDelaySeconds: 0,
    successThreshold: 1,
    failureThreshold: Math.max(Number(source.failureThreshold ?? 3), requiredFailures),
  };
}

function patchBody(
  deployment: DeploymentRef,
  input: RuntimeRolloutInput,
  session: string,
  configMapName: string,
  volumeName: string,
  mountPath: string,
  runtimeDir: string,
  process: ProcessFacts,
): string {
  const existingCapabilities = (deployment.container.securityContext?.capabilities?.add ?? []).map(String);
  const capabilities = [...existingCapabilities];
  for (const requested of input.capabilities ?? []) {
    if (!capabilities.some((item) => item.toUpperCase() === requested.toUpperCase())) {
      capabilities.push(requested);
    }
  }
  const originalArgv = deployment.container.command?.length && Array.isArray(deployment.container.args)
    ? [...deployment.container.command, ...deployment.container.args]
    : process.pid1Argv;
  if (originalArgv.length === 0) {
    throw new Error("无法从原 Pod /proc/1/cmdline 解析业务容器实际启动命令");
  }
  // 留在 Pod template 上，doctor 进程意外中断时仍可人工解码并恢复原始启动配置。
  const original = Buffer.from(JSON.stringify({
    command: deployment.container.command ?? null,
    args: deployment.container.args ?? null,
    startupProbe: deployment.container.startupProbe,
    capabilities: existingCapabilities,
  })).toString("base64");
  return JSON.stringify({
    spec: {
      template: {
        metadata: {
          annotations: {
            "doctor.dev/runtime-session": session,
            "doctor.dev/runtime-original": original,
          },
        },
        spec: {
          volumes: [{ name: volumeName, configMap: { name: configMapName, defaultMode: 0o555 } }],
          containers: [{
            name: input.container.name,
            command: [process.python, `${mountPath}/bootstrap.py`],
            args: [
              runtimeDir,
              String(BOOTSTRAP_TIMEOUT_SECONDS),
              "--",
              ...originalArgv,
            ],
            startupProbe: widenedStartupProbe(deployment.container),
            securityContext: { capabilities: { add: capabilities } },
            volumeMounts: [{ name: volumeName, mountPath, readOnly: true }],
          }],
        },
      },
    },
  });
}

function restoreBody(
  deployment: DeploymentRef,
  input: RuntimeRolloutInput,
  volumeName: string,
  mountPath: string,
): string {
  const capabilities = deployment.container.securityContext?.capabilities?.add;
  return JSON.stringify({
    spec: {
      template: {
        metadata: {
          annotations: {
            "doctor.dev/runtime-session": null,
            "doctor.dev/runtime-original": null,
          },
        },
        spec: {
          volumes: [{ name: volumeName, $patch: "delete" }],
          containers: [{
            name: input.container.name,
            command: deployment.container.command ?? null,
            args: deployment.container.args ?? null,
            startupProbe: deployment.container.startupProbe ?? null,
            securityContext: { capabilities: { add: capabilities ?? null } },
            volumeMounts: [{ mountPath, $patch: "delete" }],
          }],
        },
      },
    },
  });
}

function podForSession(raw: string, session: string, containerName: string): string | undefined {
  const pods = JSON.parse(raw) as any;
  const candidates = (pods.items ?? []).filter((pod: any) => {
    if (pod.metadata?.annotations?.["doctor.dev/runtime-session"] !== session) return false;
    if (pod.metadata?.deletionTimestamp || pod.status?.phase !== "Running") return false;
    return (pod.status?.containerStatuses ?? []).some(
      (status: any) => status.name === containerName && status.state?.running,
    );
  });
  candidates.sort((left: any, right: any) => String(right.metadata?.creationTimestamp ?? "")
    .localeCompare(String(left.metadata?.creationTimestamp ?? "")));
  return candidates[0]?.metadata?.name;
}

async function waitForBootstrapPod(
  input: RuntimeRolloutInput,
  deployment: DeploymentRef,
  session: string,
): Promise<string> {
  const started = Date.now();
  let nextProgressAt = 10_000;
  while (Date.now() - started < POD_WAIT_TIMEOUT_MS) {
    const pods = await input.exec.run(["get", "pods", "-l", deployment.selector, "-o", "json"], {
      timeoutMs: 20_000,
    });
    if (!pods.ok) throw new Error(`替代 Pod 列表读取失败：${failReason(pods)}`);
    const podName = podForSession(pods.stdout, session, input.container.name);
    if (podName) {
      record(input.bundle, "runtime-bootstrap-pod", "等待 runtime bootstrap Pod", pods, "json", "observe");
      input.log(`[collect] runtime bootstrap Pod ${podName} 已启动，开始上传诊断资产…`);
      return podName;
    }
    const elapsed = Date.now() - started;
    if (elapsed >= nextProgressAt) {
      input.log(
        `[collect] 仍在等待 deployment/${deployment.name} 的 runtime bootstrap Pod 启动（已等待 ${Math.floor(elapsed / 1_000)}s，最长 ${POD_WAIT_TIMEOUT_MS / 1_000}s）…`,
      );
      nextProgressAt += 10_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`等待 runtime bootstrap Pod 超时（${POD_WAIT_TIMEOUT_MS}ms）`);
}

async function upload(
  input: RuntimeRolloutInput,
  target: ExecTarget,
  python: string,
  path: string,
  bytes: Uint8Array,
  mode: number,
  id: string,
  title: string,
): Promise<{ path: string; sha256: string; mode: number }> {
  const digest = sha256(bytes);
  input.log(`[collect] ${title}…`);
  const result = await input.exec.exec(target, [python, "-c", UPLOAD_SCRIPT, path, digest, String(mode)], {
    stdin: bytes,
    timeoutMs: 60_000,
  });
  record(input.bundle, id, title, result);
  if (!result.ok) throw new Error(`${title}失败：${failReason(result)}`);
  input.log(`[collect] ${title}完成。`);
  return { path, sha256: digest, mode };
}

async function restore(
  input: RuntimeRolloutInput,
  deployment: DeploymentRef,
  volumeName: string,
  mountPath: string,
  configMapName: string,
): Promise<void> {
  input.log(`[collect] 恢复 deployment/${deployment.name} 原始启动配置并触发回滚 rollout…`);
  const restored = await input.exec.run([
    "patch",
    "deployment",
    deployment.name,
    "--type=strategic",
    "--patch",
    restoreBody(deployment, input, volumeName, mountPath),
  ], { timeoutMs: 30_000 });
  record(input.bundle, "runtime-workload-restore", "恢复业务 Deployment 原始配置", restored, "json");
  if (!restored.ok) {
    input.log("[collect] Deployment 原始配置恢复失败；保留 bootstrap ConfigMap，详情将写入报告。");
    input.notes.push(`runtime rollout 配置恢复失败：${failReason(restored)}`);
    input.bundle.addStep({
      id: "runtime-bootstrap-delete",
      title: "删除 runtime bootstrap ConfigMap",
      risk: "disrupt",
      status: "skipped",
      reason: "Deployment 仍引用 bootstrap ConfigMap，保留它以避免现有或后续 Pod 挂载失败",
    });
    return;
  }
  input.log("[collect] Deployment 原始配置已恢复；等待业务 Pod 回滚完成（最长 180s）…");
  const rollout = await input.exec.run([
    "rollout",
    "status",
    `deployment/${deployment.name}`,
    "--timeout=180s",
  ], { timeoutMs: 195_000 });
  record(input.bundle, "runtime-workload-rollback", "等待业务 Deployment 回滚完成", rollout);
  if (!rollout.ok) {
    input.log("[collect] 业务 Deployment 回滚未完成；继续清理 bootstrap ConfigMap，详情将写入报告。");
    input.notes.push(`runtime rollout 回滚未完成：${failReason(rollout)}`);
  } else {
    input.log("[collect] 业务 Deployment 回滚完成；清理 bootstrap ConfigMap…");
  }
  const removed = await input.exec.run([
    "delete",
    "configmap",
    configMapName,
    "--ignore-not-found=true",
  ], { timeoutMs: 20_000 });
  record(input.bundle, "runtime-bootstrap-delete", "删除 runtime bootstrap ConfigMap", removed);
  input.log(
    removed.ok
      ? "[collect] runtime rollout 清理完成。"
      : "[collect] bootstrap ConfigMap 清理失败，详情将写入报告。",
  );
}

export async function withK8sRuntimeRollout<T>(
  input: RuntimeRolloutInput,
  action: (context: RuntimeRolloutContext) => Promise<T>,
): Promise<RuntimeRolloutResult<T>> {
  let deployment: DeploymentRef | undefined;
  let configMapName: string | undefined;
  let volumeName: string | undefined;
  let mountPath: string | undefined;
  let patched = false;
  try {
    deployment = await resolveDeployment(input);
    const auth = await authorize(
      input,
      runtimeRolloutOp(input, deployment.name),
      input.operation.purpose,
    );
    if (!auth.approved) return { ok: false, reason: auth.reason, declined: true };
    input.log("[collect] disrupt 操作已确认；检查原 Pod bootstrap 运行环境…");
    const session = sessionId();
    configMapName = `doctor-bootstrap-${session}`;
    volumeName = `doctor-bootstrap-${session}`;
    mountPath = `/tmp/doctor-bootstrap-${session}`;
    const runtimeDir = `/tmp/doctor-runtime-${session}`;
    const target = { pod: input.podName, container: input.container.name };
    const processResult = await input.exec.exec(target, ["python3", "-c", PROCESS_FACTS_SCRIPT, runtimeDir], {
      timeoutMs: 20_000,
    });
    if (!processResult.ok) {
      record(input.bundle, "runtime-process-facts", "定位 bootstrap Python 并检查临时目录", {
        ...processResult,
        stdout: "",
      }, "json", "observe");
      throw new Error(`bootstrap 运行环境检查失败：${failReason(processResult)}`);
    }
    let rawProcess: Partial<ProcessFacts>;
    try {
      rawProcess = JSON.parse(processResult.stdout) as Partial<ProcessFacts>;
    } catch {
      record(input.bundle, "runtime-process-facts", "定位 bootstrap Python 并检查临时目录", {
        ...processResult,
        ok: false,
        stdout: "",
        stderr: "bootstrap 运行环境检查返回了无效 JSON",
      }, "json", "observe");
      throw new Error("bootstrap 运行环境检查返回了无效 JSON");
    }
    const process: ProcessFacts = {
      python: typeof rawProcess.python === "string" ? rawProcess.python : "",
      pid1Argv: Array.isArray(rawProcess.pid1Argv)
        && rawProcess.pid1Argv.every((value) => typeof value === "string")
        ? rawProcess.pid1Argv
        : [],
    };
    // PID 1 argv 可能含业务参数或凭据，仅用于生成本轮临时 Deployment patch；证据只保留参数数量。
    record(input.bundle, "runtime-process-facts", "定位 bootstrap Python 并检查临时目录", {
      ...processResult,
      stdout: `${JSON.stringify({ python: process.python, pid1_argv_count: process.pid1Argv.length })}\n`,
    }, "json", "observe");
    if (!process.python) throw new Error("未找到 bootstrap 使用的 Python 解释器");

    input.log("[collect] 原 Pod bootstrap 运行环境可用；创建临时 runtime ConfigMap…");
    const configMap = await input.exec.run(["apply", "-f", "-"], {
      stdin: JSON.stringify({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: configMapName, labels: { "app.kubernetes.io/managed-by": "doctor" } },
        data: { "bootstrap.py": input.bootstrapSource ?? defaultBootstrapSource },
      }),
      timeoutMs: 30_000,
    });
    record(input.bundle, "runtime-bootstrap-create", "创建 runtime bootstrap ConfigMap", configMap, "json");
    if (!configMap.ok) throw new Error(`bootstrap ConfigMap 创建失败：${failReason(configMap)}`);

    input.log(`[collect] runtime ConfigMap 已创建；修改 deployment/${deployment.name} 并启动替代 Pod…`);
    const patch = await input.exec.run([
      "patch",
      "deployment",
      deployment.name,
      "--type=strategic",
      "--patch",
      patchBody(deployment, input, session, configMapName, volumeName, mountPath, runtimeDir, process),
    ], { timeoutMs: 30_000 });
    record(input.bundle, "runtime-workload-patch", "部署两阶段 doctor runtime", safeWorkloadPatch(patch), "json");
    if (!patch.ok) throw new Error(`Deployment 修改失败：${failReason(patch)}`);
    patched = true;

    input.log(`[collect] deployment/${deployment.name} 已修改；等待 runtime bootstrap Pod 启动（最长 150s）…`);
    const podName = await waitForBootstrapPod(input, deployment, session);
    const replacement = { pod: podName, container: input.container.name };
    const files = [];
    const assetPaths: Record<string, string> = {};
    for (const asset of input.assets) {
      const path = `${runtimeDir}/${asset.relativePath}`;
      assetPaths[asset.key] = path;
      files.push(await upload(
        input,
        replacement,
        process.python,
        path,
        asset.bytes,
        asset.mode,
        asset.stepId,
        asset.title,
      ));
    }
    const ready = new TextEncoder().encode(`${JSON.stringify({ session, files })}\n`);
    await upload(
      input,
      replacement,
      process.python,
      `${runtimeDir}/READY`,
      ready,
      0o444,
      "runtime-ready-upload",
      "提交 runtime READY 标记",
    );

    input.log(
      `[collect] runtime 资产已就绪；等待诊断 Deployment rollout 完成（最长 ${RUNTIME_ROLLOUT_TIMEOUT_SECONDS}s）…`,
    );
    const rollout = await input.exec.run([
      "rollout",
      "status",
      `deployment/${deployment.name}`,
      `--timeout=${RUNTIME_ROLLOUT_TIMEOUT_SECONDS}s`,
    ], { timeoutMs: (RUNTIME_ROLLOUT_TIMEOUT_SECONDS + 15) * 1_000 });
    record(input.bundle, "runtime-workload-rollout", "等待诊断 Deployment rollout", rollout);
    if (!rollout.ok) throw new Error(`诊断 Deployment rollout 未完成：${failReason(rollout)}`);
    input.log("[collect] 诊断 Deployment rollout 已完成；读取替代 Pod 状态…");
    const pod = await input.exec.run(["get", "pod", podName, "-o", "json"], { timeoutMs: 20_000 });
    record(input.bundle, "runtime-workload-pod", "读取诊断替代 Pod", pod, "json", "observe");
    if (!pod.ok) throw new Error(`诊断替代 Pod 读取失败：${failReason(pod)}`);

    const value = await action({
      workload: { kind: "Deployment", name: deployment.name },
      podName,
      podJson: pod.stdout,
      target: replacement,
      runtimeDir,
      assetPaths,
    });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (patched && deployment && configMapName && volumeName && mountPath) {
      await restore(input, deployment, volumeName, mountPath, configMapName);
    } else if (configMapName) {
      const removed = await input.exec.run([
        "delete",
        "configmap",
        configMapName,
        "--ignore-not-found=true",
      ], { timeoutMs: 20_000 });
      record(input.bundle, "runtime-bootstrap-delete", "删除 runtime bootstrap ConfigMap", removed);
    }
  }
}
