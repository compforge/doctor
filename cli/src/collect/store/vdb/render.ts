import { effectiveDiskSettings, vdbCapacityConclusion } from "./detector";
import type { DiagnosisCoverage } from "../../protocol";
import type { VdbDiagnosisGoal, VdbFinding, VdbObservations } from "./model";

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function buildVdbSummary(input: {
  pod: string;
  container?: string;
  store: string;
  source: string;
  channel: string;
  observations: VdbObservations;
  findings: readonly VdbFinding[];
  coverage?: readonly DiagnosisCoverage<VdbDiagnosisGoal>[];
}): string {
  const { observations } = input;
  const health = observations.health;
  const stats = observations.stats;
  const shards = observations.shards;
  const diskSettings = effectiveDiskSettings(observations);
  const lines = [
    "# VDB 诊断摘要",
    "",
    `- 配置来源: \`pod/${input.pod}${input.container ? ` container/${input.container}` : ""}\`（${input.source}）`,
    `- VDB: \`${input.store}\``,
    `- 访问通道: ${input.channel}`,
    `- 容量结论: **${vdbCapacityConclusion(observations)}**`,
    "",
    "## 诊断结论",
    "",
  ];
  if (!input.findings.length) lines.push("- 本次已取得的证据未命中健康或容量异常规则。");
  else for (const finding of input.findings) {
    lines.push(`- **${finding.severity} / ${finding.kind}**：${finding.summary}`);
  }
  lines.push(
    "",
    "## Capacity policy",
    "",
    `- low: ${diskSettings.low.raw}${diskSettings.source === "fallback-defaults" ? "（含 fallback）" : ""}`,
    `- high: ${diskSettings.high.raw}${diskSettings.source === "fallback-defaults" ? "（含 fallback）" : ""}`,
    `- flood-stage: ${diskSettings.floodStage.raw}${diskSettings.source === "fallback-defaults" ? "（含 fallback）" : ""}`,
    `- read_only_allow_delete indices: ${observations.indexBlocks?.readOnlyAllowDelete.length ?? "未取得"}`,
    "",
    "## Cluster",
    "",
    "| health | nodes | data nodes | active primary | active shards | unassigned | pending tasks |",
    "|---|---:|---:|---:|---:|---:|---:|",
    `| ${health?.status ?? "-"} | ${health?.nodes ?? "-"} | ${health?.dataNodes ?? "-"} | ${health?.activePrimaryShards ?? "-"} | ${health?.activeShards ?? "-"} | ${health?.unassignedShards ?? "-"} | ${health?.pendingTasks ?? "-"} |`,
    "",
    "## Data node 磁盘",
    "",
    "| node | shards | used | available | total | usage |",
    "|---|---:|---:|---:|---:|---:|",
  );
  for (const node of observations.allocation?.nodes ?? []) {
    lines.push(
      `| ${node.node} | ${node.shards} | ${formatBytes(node.diskUsedBytes)} | ${formatBytes(node.diskAvailableBytes)} | ${formatBytes(node.diskTotalBytes)} | ${node.diskPercent === undefined ? "-" : `${node.diskPercent}%`} |`,
    );
  }
  if (!observations.allocation?.nodes.length) lines.push("| - | - | - | - | - | - |");
  lines.push(
    "",
    "## 数据与 shard",
    "",
    "| indices | documents | deleted docs | store | shards | primary shards | unassigned primary | unassigned replica |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|",
    `| ${stats?.indices ?? "-"} | ${stats?.documents ?? "-"} | ${stats?.deletedDocuments ?? "-"} | ${formatBytes(stats?.storeBytes)} | ${stats?.shards ?? shards?.total ?? "-"} | ${stats?.primaryShards ?? "-"} | ${shards?.unassignedPrimary ?? "-"} | ${shards?.unassignedReplica ?? "-"} |`,
  );
  if (observations.missing.length) {
    lines.push("", "## 证据缺口", "", `- ${observations.missing.join("；")}`);
  }
  if (input.coverage?.length) {
    lines.push("", "## Coverage", "");
    for (const item of input.coverage) {
      lines.push(`- ${item.goal}: ${item.status}`);
      for (const missing of item.missingEvidence) lines.push(`  - 缺失：${missing}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
