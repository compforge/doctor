import type { Client } from "@compforge/harness-toolbox/client";
import { dataSourceKey } from "@compforge/harness-toolbox/datasource";
import { currentCommandClients } from "../../command/execution-scope";
import { PortForwardTransport } from "@compforge/harness-toolbox/transport";
import { RedisAccess, type RedisAccessApi } from "@compforge/harness-toolbox/redis/index";
import { ServicePortForwarder } from "@compforge/harness-toolbox/kubernetes/service-port-forward";
import type { Executor, ExecTarget } from "@compforge/harness-toolbox/kubernetes/executor";
import type { RedisConfig } from "./config";
import type { RedisEnvironmentFact, RedisTargetFact } from "./fact/model";
import { buildRedisEnvironmentFact, buildRedisTargetFact } from "./fact/model";
import { failedFact, unavailableFact } from "../protocol";
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
    : failedFact(
        "redis.environment",
        "redis-target",
        `读取运行时配置失败：${envResult.stderr.trim() || `exit=${envResult.exitCode}`}`,
      );
  if (!envResult.ok && !config.url && !config.profile?.url) {
    const reason = environmentFact.status === "failed" ? environmentFact.reason : "读取运行时配置失败";
    return {
      targetFact: failedFact("redis.target", "redis-target", reason),
      environmentFact,
      command: envResult.command,
      reason,
    };
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
      targetFact: unavailableFact("redis.target", "redis-target", reason),
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
    return {
      targetFact: failedFact("redis.target", "redis-target", reason),
      environmentFact,
      command: envResult.command,
      reason,
    };
  }
}

/** Owns connection preparation; topology and observations remain per collection. */
class RedisAccessClient implements Client {
  #initialization?: Promise<void>;
  #disposal?: Promise<void>;
  #forwarder?: ServicePortForwarder;
  access?: RedisAccess;
  constructor(private readonly executor: Executor, private readonly config: RedisConfig,
    private readonly target: RedisTarget, private readonly signal?: AbortSignal) {}
  initialize(): Promise<void> {
    return this.#initialization ??= (async () => {
      this.signal?.throwIfAborted();
      const kubernetes = this.config.collect.kubernetes;
      this.#forwarder = await ServicePortForwarder.create(this.executor, kubernetes);
      this.signal?.throwIfAborted();
      this.access = new RedisAccess(new PortForwardTransport(endpoint => this.#forwarder!.forward(endpoint)), {
        username: this.target.username, password: this.target.password,
        useSsl: this.target.useSsl, timeoutMs: this.target.timeout * 1_000,
      });
      const initial = this.target.clusterType === "sentinel" && this.target.sentinelHosts.length
        ? this.target.sentinelHosts : this.target.endpoints;
      // Wait for every started forward before failure cleanup can stop the forwarder.
      const results = await Promise.allSettled(initial.map(([host, port]) => this.#forwarder!.forward({ host, port })));
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      this.signal?.throwIfAborted();
    })();
  }
  get forwards() { return this.#forwarder?.activeForwards ?? []; }
  dispose(): Promise<void> {
    return this.#disposal ??= (async () => {
      await this.#initialization?.catch(() => {});
      try { await this.access?.close(); }
      finally { this.#forwarder?.stop(); }
    })();
  }
}

/** Nested commands borrow access; standalone callers retain explicit ownership. */
export async function prepareRedisAccess(
  executor: Executor,
  config: RedisConfig,
  target: RedisTarget,
  injectedAccess?: RedisAccessApi,
): Promise<PreparedRedisAccess> {
  if (injectedAccess) return { access: injectedAccess, forwards: [], close: () => injectedAccess.close() };
  const clients = currentCommandClients();
  let local: RedisAccessClient | undefined;
  try {
    const client = clients
      ? await clients.get({
          key: dataSourceKey("redis-access", { kubernetes: config.collect.kubernetes, target }),
          createClient: signal => new RedisAccessClient(executor, config, target, signal),
        })
      : (local = new RedisAccessClient(executor, config, target));
    if (local) await local.initialize();
    return { access: client.access, forwards: client.forwards, close: local ? () => client.dispose() : async () => {} };
  } catch (error) {
    await local?.dispose();
    return { forwards: [], reason: error instanceof Error ? error.message : String(error), close: async () => {} };
  }
}
