import type { EvidenceBundle } from "../evidence";
import type { Executor, ExecTarget } from "@compforge/harness-toolbox/kubernetes/executor";
import type { RedisTarget } from "./fact/target";
import type { RedisAccessApi } from "@compforge/harness-toolbox/redis/index";
import { discoverRedisTopology, type RedisTopology } from "@compforge/harness-toolbox/redis/index";
import type { RedisConfig } from "./config";
import type { CommandContext } from "../../command";

/** Redis Inspect / Probe 执行命令和记账所需的运行工具；诊断证据仍只走 Facts / Observation。 */
export interface RedisCommandContext {
  command: CommandContext;
  config: RedisConfig;
  exec: Executor;
  execTarget?: ExecTarget;
  /** 包含凭据的本轮执行态；只供 Inspect/Probe 使用，不进入 Facts 或证据包。 */
  redisTarget?: RedisTarget;
  /** 采集准备阶段建立的本机 Redis 访问面。 */
  redisAccess?: RedisAccessApi;
  closePreparation?: () => Promise<void>;
  bundle: EvidenceBundle;
  log: (line: string) => void;
}

/** @spec Topology is an observation; refresh it while reusing the source's root-owned connections. */
export function redisTopology(ctx: RedisCommandContext): Promise<RedisTopology> {
  if (ctx.config.client) return ctx.config.client.topology();
  if (!ctx.redisTarget || !ctx.redisAccess) throw new Error("Redis 执行态目标未就绪");
  return discoverRedisTopology(ctx.redisAccess, ctx.redisTarget);
}
