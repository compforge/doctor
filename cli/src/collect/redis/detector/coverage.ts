import type { DiagnosisCoverage } from "../../protocol";
import type { RedisDiagnosisGoal } from "../findings";
import {
  redisMasters,
  redisMemoryCapacity,
  redisNodes,
  redisScans,
  type RedisEvidence,
  type RedisOverviewObservation,
} from "../model";

// coverage 的职责不止"缺什么"，还要"为什么缺、怎么补"（判据见 protocol.ts 的 Evidence 注释）。
// Inspect 的预期失败现在保留为带 status 的子 Fact；Probe 即使不可运行，Detector/Coverage
// 仍会执行，因此优先用具体 Fact 解释整份 Redis 证据为什么没有取得。
function prerequisiteGap(e: RedisEvidence): string | undefined {
  const facts = [
    ["Redis 执行环境", e.facts.execution],
    ["Redis 目标", e.facts.target],
    ["TS Redis 客户端连通性", e.facts.capabilities],
  ] as const;
  for (const [label, fact] of facts) {
    if (fact.status !== "collected") return `${label} Fact ${fact.status}：${fact.reason}`;
  }
  return undefined;
}

function mastersGap(e: RedisEvidence): string {
  const base = "Redis master 节点信息";
  const errors = redisNodes(e)
    .map((node) => node.error)
    .filter((error): error is string => !!error);
  if (errors.length > 0) return `${base}（节点连接失败：${errors[0]}）`;
  return base;
}

function scansGap(e: RedisEvidence): string {
  const base = "Redis keyspace 抽样";
  const overview = e.observations.find(
    (item): item is RedisOverviewObservation => item.kind === "overview",
  );
  if (overview?.scanMode === "quick") {
    return `${base}（quick 模式不扫描 key；去掉 --quick 以 sample 模式重新采集可取得）`;
  }
  return base;
}

export function buildRedisCoverage(
  e: RedisEvidence,
): DiagnosisCoverage<RedisDiagnosisGoal>[] {
  const prerequisite = prerequisiteGap(e);
  if (prerequisite) {
    return ["redis-memory-capacity", "redis-memory-distribution"].map((goal) => ({
      goal: goal as RedisDiagnosisGoal,
      status: "insufficient" as const,
      missingEvidence: [prerequisite],
    }));
  }
  const masters = redisMasters(e);
  const scans = redisScans(e);
  const mastersWithoutCapacity = masters.filter((master) => !redisMemoryCapacity(master));
  const capacityGap = mastersWithoutCapacity.length > 0
    ? `Redis master 未配置 maxmemory（${mastersWithoutCapacity.map((node) => `${node.host}:${node.port}`).join("、")}）；缺少 Pod/cgroup 容量证据`
    : undefined;
  const missingEvidence: string[] = [];
  if (masters.length === 0) missingEvidence.push(mastersGap(e));
  if (scans.length === 0) missingEvidence.push(scansGap(e));
  return [
    {
      goal: "redis-memory-capacity",
      status: masters.length === 0 ? "insufficient" : capacityGap ? "partial" : "sufficient",
      missingEvidence: masters.length === 0 ? [mastersGap(e)] : capacityGap ? [capacityGap] : [],
    },
    {
      goal: "redis-memory-distribution",
      status: missingEvidence.length === 0 ? "sufficient" : masters.length > 0 ? "partial" : "insufficient",
      missingEvidence,
    },
  ];
}
