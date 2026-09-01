import type { EvidenceBundle } from "../evidence";
import type { Executor, ExecTarget } from "../../infra/k8s/executor";
import type { RedisTarget } from "./fact/target";
import type { RedisAccessApi } from "../../infra/redis";
import type { RedisTopologyConfig } from "../../infra/redis";
import type { RedisConfig } from "./config";
import type { CommandContext } from "../../command";

/** Redis Inspect / Probe 执行命令和记账所需的运行工具；诊断证据仍只走 Facts / Observation。 */
export interface RedisCommandContext {
  command: CommandContext;
  config: RedisConfig;
  exec: Executor;
  execTarget: ExecTarget;
  /** 包含凭据的本轮执行态；只供 Inspect/Probe 使用，不进入 Facts 或证据包。 */
  redisTarget?: RedisTarget;
  /** 采集准备阶段建立的本机 Redis 访问面。 */
  redisAccess?: RedisAccessApi;
  closePreparation?: () => Promise<void>;
  bundle: EvidenceBundle;
  log: (line: string) => void;
}

export function redisTopologyConfig(ctx: RedisCommandContext): RedisTopologyConfig {
  const target = ctx.redisTarget;
  if (!target) throw new Error("Redis 执行态目标未就绪");
  return {
    endpoints: target.endpoints.map(([host, port]) => ({ host, port })),
    database: target.database,
    username: target.username,
    password: target.password,
    clusterType: target.clusterType,
    sentinelHosts: target.sentinelHosts.map(([host, port]) => ({ host, port })),
    sentinelMasterName: target.sentinelMasterName,
    sentinelUsername: target.sentinelUsername,
    sentinelPassword: target.sentinelPassword,
  };
}
