import {
  createKubernetesExecutor,
  resolveKubernetesCommandConfig,
  type KubernetesCommandConfig,
} from "../../command/kubernetes-target";
import { failReason } from "../../infra/k8s/result";
import { findPodsForService, listServiceNetwork } from "../../infra/k8s/service";
import {
  parsePodChoices,
  type PodChoice,
} from "../../infra/k8s/pod-selection";
import { parsePodJson, pickContainer } from "../../infra/k8s/target";
import {
  recentSelectionsForInteractive,
  resolveKubernetesRecentScope,
} from "../../infra/recent";
import type { CommandContext } from "../../command";
import { enforceKubernetesAccess } from "../../terminal/kubernetes-access";
import { promptMultiSelect } from "../../terminal/multi-select";
import { terminalStderr, terminalStdout } from "../../terminal/output";
import { deployDebugEnvironment } from "./apply";
import {
  inspectTargetImagePlatform,
  reportTargetPlatform,
  resolveDebugTarget,
} from "./inspect";
import type {
  BatchDebugImageResolution,
  DebugCliOpts,
  DebugPlatformSource,
  PreparedDebugImage,
} from "./model";
import {
  prepareDebugImage,
  resolveBatchDebugImage,
} from "./plan";
import {
  parseDebugServices,
  resolveDebugBatchOptions,
  resolveSelectedDebugPods,
} from "./selection";
import { reuseReadyDebugEnvironment } from "./verify";
import { resolveDebugCapabilities } from "./capabilities";
import { offerDebugInstall } from "./install-follow-up";

async function runDebugTargets(
  opts: DebugCliOpts,
  commandContext: CommandContext,
  config: KubernetesCommandConfig,
  targets: ReadonlyMap<string, string>,
  failedBeforeRun = false,
): Promise<number> {
  let failed = failedBeforeRun;
  const resolvedOpts = resolveDebugBatchOptions(opts, config);
  const imageCache = new Map<string, Promise<PreparedDebugImage>>();
  for (const [pod, container] of targets) {
    const code = await runDebugTarget(
      { ...resolvedOpts, services: undefined, pod, container },
      commandContext,
      imageCache,
    );
    if (code === 130) return 130;
    if (code !== 0) failed = true;
  }
  terminalStdout.result(
    !failed,
    `[debug] debug container 准备完成：${targets.size} Pod，`
    + `${failed ? "存在失败" : "全部就绪"}\n`,
  );
  return failed ? 1 : 0;
}

async function runDebugServices(
  opts: DebugCliOpts,
  commandContext: CommandContext,
): Promise<number> {
  if (opts.pod) throw new Error("--services 与 --pod 不能同时使用");
  const config = await resolveKubernetesCommandConfig(
    opts,
    undefined,
    commandContext,
  );
  if (!config) return 130;
  const executor = createKubernetesExecutor(config);
  const access = commandContext.kubernetes(executor).access;
  await enforceKubernetesAccess(access, {
    command: "doctor debug --services",
    needs: [{
      requirement: "required",
      rule: { verb: "list", resource: "services" },
      purpose: "解析指定 Service",
    }, {
      requirement: "required",
      rule: { verb: "list", resource: "pods" },
      purpose: "解析 Service 对应的全部 Running Pod",
    }],
  });
  const services = parseDebugServices(opts.services!);
  const network = await listServiceNetwork(
    executor,
    config.kubernetes.namespace,
  );
  const targets = new Map<string, string>();
  let failed = false;
  for (const service of services) {
    const pods = findPodsForService(
      network.services,
      network.pods,
      service,
      config.kubernetes.namespace,
    );
    if (!network.services.some((item) =>
      item.name === service && item.namespace === config.kubernetes.namespace
    )) {
      terminalStderr.error(`[debug] Service '${service}' 不存在\n`);
      failed = true;
      continue;
    }
    if (!pods.length) {
      terminalStderr.error(`[debug] Service '${service}' 没有 Running Pod\n`);
      failed = true;
    }
    for (const pod of pods) {
      if (targets.has(pod.name)) continue;
      const captured = await executor.run(
        ["get", "pod", pod.name, "-o", "json"],
        { timeoutMs: 20_000 },
      );
      if (!captured.ok) {
        terminalStderr.error(
          `[debug] 获取 pod/${pod.name} 失败：${failReason(captured)}\n`,
        );
        failed = true;
        continue;
      }
      const parsed = parsePodJson(captured.stdout);
      const selected = opts.container
        ? pickContainer(parsed, opts.container)
        : parsed.containers[0]
          ? { ok: true as const, value: parsed.containers[0] }
          : { ok: false as const, reason: `pod/${pod.name} 没有业务容器` };
      if (!selected.ok) {
        terminalStderr.error(`[debug] ${selected.reason}\n`);
        failed = true;
        continue;
      }
      if (!opts.container && parsed.containers.length > 1) {
        terminalStdout.warning(
          `[debug] pod/${pod.name} 有多个业务容器；批量准备选择首个 `
          + `${selected.value.name} 作为 PID namespace 目标`
          + "（网络 namespace 为 Pod 共享）\n",
        );
      }
      targets.set(pod.name, selected.value.name);
    }
  }
  if (!targets.size) return 1;
  return runDebugTargets(opts, commandContext, config, targets, failed);
}

async function runDebugPods(
  opts: DebugCliOpts,
  commandContext: CommandContext,
): Promise<number> {
  const config = await resolveKubernetesCommandConfig(
    opts,
    undefined,
    commandContext,
  );
  if (!config) return 130;
  const executor = createKubernetesExecutor(config);
  const access = commandContext.kubernetes(executor).access;
  const discovery = await enforceKubernetesAccess(access, {
    command: "doctor debug",
    needs: [{
      requirement: "preferred",
      rule: { verb: "list", resource: "pods" },
      purpose: "多选 Running Pod",
      fallback: "改为手动输入一个精确 Pod 名称",
    }],
  });
  if (discovery.facts[0]?.status === "denied") {
    return runDebugTarget(opts, commandContext);
  }
  const listed = await executor.run(
    ["get", "pods", "-o", "json"],
    { timeoutMs: 20_000 },
  );
  if (!listed.ok) throw new Error(`获取 Pod 列表失败：${failReason(listed)}`);

  let choices: PodChoice[];
  const recent = recentSelectionsForInteractive(undefined);
  const recentScope = resolveKubernetesRecentScope(config.kubernetes);
  try {
    const listedChoices = parsePodChoices(listed.stdout)
      .filter((pod) => pod.phase === "Running");
    choices = recent
      ? recent.rankPods(recentScope, config.kubernetes.namespace, listedChoices)
      : listedChoices;
  } catch (error) {
    throw new Error(
      `解析 Pod 列表失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!choices.length) {
    throw new Error(`namespace '${config.kubernetes.namespace}' 中没有 Running Pod`);
  }
  const selected = await promptMultiSelect({
    choices,
    title: "[debug] 请选择要准备 debug container 的 Pod：",
    renderChoice: (pod) =>
      `${pod.name}  ${pod.phase}  ready=${pod.ready}  restarts=${pod.restarts}`,
  });
  if (!selected) return 130;

  const resolved = resolveSelectedDebugPods(
    choices,
    selected,
    opts.container?.trim(),
  );
  for (const warning of resolved.warnings) {
    terminalStdout.warning(`[debug] ${warning}\n`);
  }
  for (const error of resolved.errors) {
    terminalStderr.error(`[debug] ${error}\n`);
  }
  if (!resolved.targets.size) return 1;
  for (const [pod, container] of resolved.targets) {
    recent?.recordKubernetesTarget(recentScope, {
      namespace: config.kubernetes.namespace,
      pod,
      container,
    });
  }
  return runDebugTargets(
    opts,
    commandContext,
    config,
    resolved.targets,
    resolved.errors.length > 0,
  );
}

async function runDebugTarget(
  opts: DebugCliOpts,
  commandContext: CommandContext,
  imageCache?: Map<string, Promise<PreparedDebugImage>>,
): Promise<number> {
  const target = await resolveDebugTarget(opts, commandContext);
  if (!target) return 130;
  const capabilities = await resolveDebugCapabilities(commandContext);
  if (!capabilities) return 130;
  // A ready debug environment fully satisfies `doctor debug`; image resolution, registry
  // access, and preparation belong only to the missing-environment path.
  if (await reuseReadyDebugEnvironment(target, capabilities)) return 0;

  await enforceKubernetesAccess(target.context.kubernetes(target.executor).access, {
    command: "doctor debug",
    needs: [{
      requirement: "required",
      rule: { verb: "update", resource: "pods/ephemeralcontainers" },
      purpose: "为目标 Pod 创建 debug environment",
    }],
  });

  let platformSource: DebugPlatformSource | undefined = target.imagePlatform
    ? "node"
    : undefined;
  if (!target.imagePlatform) {
    target.imagePlatform = inspectTargetImagePlatform(target);
    if (target.imagePlatform) platformSource = "image-manifest";
  }
  let platformReported = false;
  if (target.imagePlatform) {
    reportTargetPlatform(target, platformSource);
    platformReported = true;
  }

  let resolved: BatchDebugImageResolution;
  const prepare = () =>
    prepareDebugImage(target, opts, platformSource, platformReported);
  if (imageCache && target.imagePlatform) {
    resolved = await resolveBatchDebugImage(
      imageCache,
      target.imagePlatform,
      prepare,
    );
  } else {
    resolved = {
      prepared: await prepare(),
      reused: false,
    };
  }
  if (!resolved.prepared.image) return resolved.prepared.code;
  if (resolved.reused) {
    terminalStdout.write(
      `[debug] image: ${resolved.prepared.image}（同平台已验证，批量复用）\n`,
    );
  }
  const deployed = await deployDebugEnvironment(
    target,
    resolved.prepared,
    capabilities,
    opts,
    true,
  );
  if (deployed !== 0) return deployed;
  return offerDebugInstall(
    target,
    opts,
    commandContext,
  );
}

/** Select target → reuse, otherwise deploy a prepared registry image or reuse the target image. */
export async function runDebug(
  opts: DebugCliOpts,
  commandContext: CommandContext,
): Promise<number> {
  if (opts.services) return runDebugServices(opts, commandContext);
  if (!opts.pod?.trim() && process.stdin.isTTY && process.stdout.isTTY) {
    return runDebugPods(opts, commandContext);
  }
  return runDebugTarget(opts, commandContext);
}
