import type { EvidenceBundle } from "../evidence";
import type { Executor, ExecTarget } from "../../infra/k8s/executor";
import type { RedisTarget } from "./fact/target";
import type { RedisAccessApi } from "../../infra/redis";

/** Redis Inspect / Probe 执行命令和记账所需的运行工具；诊断证据仍只走 Facts / Observation。 */
export interface RedisCollectContext {
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
