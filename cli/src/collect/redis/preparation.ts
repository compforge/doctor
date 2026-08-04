import { RedisAccess, type RedisAccessApi } from "../../infra/redis";
import { ServicePortForwarder } from "../../infra/k8s/service-port-forward";
import type { Executor, ExecTarget } from "../../infra/k8s/executor";
import type { RedisConfig } from "./config";
import type { RedisEnvironmentFact, RedisTargetFact } from "./fact/model";
import { buildRedisEnvironmentFact, buildRedisTargetFact } from "./fact/model";
import {
  extractRedisEnvironment,
  hasRedisStoreConfiguration,
  resolveRedisTarget,
  type RedisTarget,
} from "./fact/target";

export interface ConfirmedRedisTarget {
  target?: RedisTarget;
  targetFact: RedisTargetFact;
  environmentFact: RedisEnvironmentFact;
  command?: string[];
  reason?: string;
}

export interface PreparedRedisAccess {
  access?: RedisAccessApi;
  forwards: readonly { command: string[] }[];
  reason?: string;
  close(): Promise<void>;
}

/** 配置确认只决定“访问谁”，不建立连接或 port-forward。 */
export async function confirmRedisTarget(
  executor: Executor,
  execTarget: ExecTarget,
  config: RedisConfig,
): Promise<ConfirmedRedisTarget> {
  const envResult = await executor.exec(execTarget, ["env"], { timeoutMs: 20_000 });
  const environmentFact: RedisEnvironmentFact = envResult.ok
    ? buildRedisEnvironmentFact(extractRedisEnvironment(envResult.stdout))
    : {
        status: "failed",
        reason: `读取运行时配置失败：${envResult.stderr.trim() || `exit=${envResult.exitCode}`}`,
      };
  if (!envResult.ok && !config.url && !config.profile?.url) {
    const reason = environmentFact.status === "failed" ? environmentFact.reason : "读取运行时配置失败";
    return { targetFact: { status: "failed", reason }, environmentFact, command: envResult.command, reason };
  }
  if (
    envResult.ok
    && config.store
    && !config.url
    && !config.profile?.url
    && !hasRedisStoreConfiguration(envResult.stdout, config.store)
  ) {
    const reason = `Service '${config.service}' 当前未提供有效 ${config.store.environment.address}，Redis Store 未启用`;
    return {
      targetFact: { status: "unavailable", reason },
      environmentFact,
      command: envResult.command,
      reason,
    };
  }
  try {
    const target = resolveRedisTarget(
      envResult.ok ? envResult.stdout : "",
      config.profile,
      config.url,
      config.database,
      config.store,
    );
    return {
      target,
      targetFact: buildRedisTargetFact(target),
      environmentFact,
      command: envResult.command,
    };
  } catch (err) {
    const reason = `解析 Redis 目标失败：${err instanceof Error ? err.message : String(err)}`;
    return { targetFact: { status: "failed", reason }, environmentFact, command: envResult.command, reason };
  }
}

/** 采集准备建立所有初始 endpoint 的访问通道；拓扑节点在 Probe 中按需追加并由同一 scope 回收。 */
export async function prepareRedisAccess(
  executor: Executor,
  config: RedisConfig,
  target: RedisTarget,
  injectedAccess?: RedisAccessApi,
): Promise<PreparedRedisAccess> {
  if (injectedAccess) {
    return { access: injectedAccess, forwards: [], close: () => injectedAccess.close() };
  }
  let forwarder: ServicePortForwarder | undefined;
  let access: RedisAccess | undefined;
  try {
    const kubernetes = config.collect.kubernetes;
    forwarder = await ServicePortForwarder.create(executor, {
      namespace: kubernetes.namespace,
      kubeconfig: kubernetes.kubeconfig,
      context: kubernetes.context,
    });
    access = new RedisAccess(
      (endpoint) => forwarder!.forward(endpoint),
      {
        username: target.username,
        password: target.password,
        useSsl: target.useSsl,
        timeoutMs: target.timeout * 1_000,
      },
    );
    const initial = target.clusterType === "sentinel" && target.sentinelHosts.length
      ? target.sentinelHosts
      : target.endpoints;
    await Promise.all(initial.map(([host, port]) => forwarder!.forward({ host, port })));
    return {
      access,
      forwards: forwarder.activeForwards,
      close: async () => {
        await access!.close();
        forwarder!.stop();
      },
    };
  } catch (err) {
    await access?.close();
    forwarder?.stop();
    const reason = err instanceof Error ? err.message : String(err);
    return { forwards: [], reason, close: async () => undefined };
  }
}
