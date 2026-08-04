import {
  escapeHtml,
  htmlHeading,
  htmlList,
  htmlParagraph,
  htmlProgressMetrics,
  htmlTable,
  htmlTableCell,
  type HtmlPieChart,
  type HtmlProgressMetric,
} from "../output/html";
import {
  redisDatabases,
  redisMasters,
  redisMemoryCapacity,
  redisNodes,
  redisOverview,
  redisPressureWindows,
  redisScans,
  redisKeyStats,
  type RedisDiagnosis,
  type RedisScan,
} from "./model";
import type { RedisFinding } from "./findings";

export interface RedisMarkdownOptions {
  includeTtlTables?: boolean;
}

export interface RedisRenderTarget {
  endpoint: string;
  endpoint_source: string;
}

type RedisCapacityFinding = Extract<RedisFinding, { usedBytes: number }>;

function formatBytes(value: unknown): string {
  const size = Number(value || 0);
  if (!Number.isFinite(size)) return "-";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let current = size;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function byteCell(value: unknown) {
  return htmlTableCell(formatBytes(value), Number(value || 0));
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "-" : `${(value * 100).toFixed(1)}%`;
}

function assertNever(value: never): never {
  throw new Error(`未处理的 Redis Finding: ${JSON.stringify(value)}`);
}

export function describeRedisFinding(finding: RedisFinding): string {
  switch (finding.kind) {
    case "redis.memory-skew-with-balanced-keys":
      return `master key 数接近，但数据集内存最大/最小为 ${finding.memoryRatio.toFixed(2)}x，属于 key 平均大小倾斜。`;
    case "redis.memory-skew":
      return `master 数据集内存最大/最小为 ${finding.memoryRatio.toFixed(2)}x。`;
    case "redis.memory-skew-dominated-by-large-keys":
      return `${finding.node.host}:${finding.node.port} db${finding.database} 的 Top ${finding.keyCount} 大 key 合计占节点数据集内存的 ${(finding.datasetShare * 100).toFixed(1)}%，可解释 ${(finding.skewExcessShare * 100).toFixed(1)}% 的 master 额外内存，是本次倾斜的主要来源。`;
    case "redis.sampled-key-size-skew":
      return `db${finding.database} 抽样 key 平均内存最大/最小为 ${finding.ratio.toFixed(2)}x。`;
    case "redis.prefix-concentration":
      return `${finding.node.host}:${finding.node.port} db${finding.database} 抽样内存中 ${(finding.share * 100).toFixed(1)}% 集中在前缀 ${finding.prefix}。`;
    case "redis.type-concentration":
      return `${finding.node.host}:${finding.node.port} db${finding.database} 抽样内存中 ${(finding.share * 100).toFixed(1)}% 为 ${finding.redisType} 类型。`;
    case "redis.slot-concentration":
      return `${finding.node.host}:${finding.node.port} db${finding.database} 抽样内存中 ${(finding.share * 100).toFixed(1)}% 集中在 slot ${finding.slot}。`;
    case "redis.streams-without-ttl":
      return `db${finding.database} 抽样中发现 ${finding.count} 个无 TTL Stream；结合 top_streams 检查是否同时缺少长度限制。`;
    case "redis.memory-fragmentation":
      return `${finding.node.host}:${finding.node.port} mem_fragmentation_ratio=${finding.ratio.toFixed(2)}。`;
    case "redis.memory-capacity-high":
      return `${finding.node.host}:${finding.node.port} Redis 计入 maxmemory 的内存为 ${formatBytes(finding.usedBytes)} / ${formatBytes(finding.maxBytes)}（${formatPercent(finding.utilization)}），容量偏高；淘汰策略为 ${finding.policy}。`;
    case "redis.memory-capacity-exhausted": {
      const policyRisk = finding.policy.startsWith("volatile-")
        ? "；该策略只能淘汰有 TTL 的 key，无可淘汰 key 时将拒绝写入"
        : finding.policy === "noeviction"
          ? "；该策略会拒绝新增内存的写命令"
          : "";
      const activePressure = finding.evictedKeysDelta > 0 || finding.oomErrorsDelta > 0
        ? `；本次 ${finding.observationSeconds.toFixed(1)} 秒观察到 ${finding.evictedKeysDelta} 个 key 被淘汰、${finding.oomErrorsDelta} 次 OOM 拒写`
        : finding.oomErrors > 0
          ? `；当前仍接近上限，且累计已有 ${finding.oomErrors} 次 OOM 拒写`
          : "";
      return `${finding.node.host}:${finding.node.port} Redis 计入 maxmemory 的内存为 ${formatBytes(finding.usedBytes)} / ${formatBytes(finding.maxBytes)}（${formatPercent(finding.utilization)}），已处于容量压力状态${activePressure}；淘汰策略为 ${finding.policy}${policyRisk}。`;
    }
    case "redis.oom-errors-observed":
      return `${finding.node.host}:${finding.node.port} 已累计记录 ${finding.count} 次 Redis OOM 错误，说明写命令曾因容量限制被拒绝。`;
    case "redis.evictions-observed":
      return `${finding.node.host}:${finding.node.port} 已累计淘汰 ${finding.count} 个 key。`;
    default:
      return assertNever(finding);
  }
}

function findingLabel(finding: RedisFinding): string {
  return `${finding.severity} / ${finding.kind} / confidence=${finding.confidence}`;
}

function redisCapacityMetrics(diagnosis: RedisDiagnosis): HtmlProgressMetric[] {
  return redisMasters(diagnosis.evidence).flatMap((node): HtmlProgressMetric[] => {
    const capacity = redisMemoryCapacity(node);
    if (!capacity) {
      const usedBytes = Number(node.info?.used_memory);
      if (!Number.isFinite(usedBytes) || usedBytes < 0) return [];
      return [{
        title: `${node.host}:${node.port}`,
        value: usedBytes,
        max: 0,
        valueLabel: `已占用 ${formatBytes(usedBytes)}`,
        maxLabel: "总量未知",
        status: "Redis 未配置 maxmemory，无法计算容量利用率",
        tone: "normal",
        indeterminate: true,
      }];
    }
    const finding = diagnosis.findings.find((item): item is RedisCapacityFinding =>
      "usedBytes" in item
      && item.node.host === node.host
      && item.node.port === node.port
    );
    const windows = redisPressureWindows(diagnosis.evidence, node);
    const firstWindow = windows[0];
    const longestWindow = windows.at(-1);
    const evictedDelta = firstWindow?.evictedKeysDelta ?? finding?.evictedKeysDelta ?? 0;
    const oomDelta = firstWindow?.oomErrorsDelta ?? finding?.oomErrorsDelta ?? 0;
    const tone = finding?.kind === "redis.memory-capacity-exhausted"
      ? "critical"
      : finding?.kind === "redis.memory-capacity-high"
        ? "warning"
        : "normal";
    let status = "容量正常";
    if (evictedDelta > 0 && oomDelta > 0) status = "容量已满：正在驱逐老 key，仍有写入被 OOM 拒绝";
    else if (evictedDelta > 0) status = "容量已满：正在驱逐老 key";
    else if (oomDelta > 0) status = "容量已满：已有写入被 OOM 拒绝";
    else if ((longestWindow?.evictedKeysDelta ?? 0) > 0 && (longestWindow?.oomErrorsDelta ?? 0) > 0) status = "容量压力：10 秒内发生 key 驱逐和 OOM 拒写";
    else if ((longestWindow?.evictedKeysDelta ?? 0) > 0) status = "容量压力：10 秒内发生 key 驱逐";
    else if ((longestWindow?.oomErrorsDelta ?? 0) > 0) status = "容量压力：10 秒内发生 OOM 拒写";
    else if (finding?.kind === "redis.memory-capacity-exhausted") status = "容量瓶颈已确认";
    else if (finding?.kind === "redis.memory-capacity-high") status = "容量偏高";
    const details = windows.map((window) =>
      `${window.observationSeconds.toFixed(1)} 秒观察窗口：淘汰 ${window.evictedKeysDelta} 个 key，OOM 拒写 ${window.oomErrorsDelta} 次`
    );
    return [{
      title: `${node.host}:${node.port}`,
      value: capacity.usedBytes,
      max: capacity.maxBytes,
      valueLabel: formatBytes(capacity.usedBytes),
      maxLabel: formatBytes(capacity.maxBytes),
      status,
      details,
      tone,
    }];
  });
}

function redisCapacityStatus(diagnosis: RedisDiagnosis): string {
  const masters = redisMasters(diagnosis.evidence);
  const metrics = redisCapacityMetrics(diagnosis);
  if (masters.length === 0) return htmlParagraph("未采集到 Redis master 容量信息。");
  const content = [htmlProgressMetrics(metrics)];
  if (masters.some((node) => !redisMemoryCapacity(node))) {
    content.push(htmlParagraph("部分或全部 Redis master 未配置 maxmemory，无法仅凭 Redis 判断对应 Pod/cgroup 容量。"));
  }
  return content.join("");
}

function redisScanDetailsHtml(scan: RedisScan): string {
  return `${htmlParagraph(`已检查 ${scan.scanned_keys} 个 key，${scan.scan_complete ? "已扫完整个 keyspace" : "按完整 SCAN 游标分组随机采样"}；检查范围内内存 ${formatBytes(scan.sampled_memory_bytes)}，平均 ${formatBytes(scan.average_sampled_bytes_per_key)}/key。`)}
      <h4>类型 TopN</h4>
      ${htmlTable(
        ["type", "count", "memory", "no TTL", "no TTL memory"],
        scan.types.map((row) => [row.name, row.count, byteCell(row.memory_bytes), row.no_ttl_count, byteCell(row.no_ttl_memory_bytes)]),
      )}
      <h4>前缀 TopN</h4>
      ${htmlTable(
        ["prefix", "count", "memory", "no TTL"],
        scan.prefixes.map((row) => [row.name, row.count, byteCell(row.memory_bytes), row.no_ttl_count]),
      )}
      <h4>Big Key TopN</h4>
      ${htmlTable(
        ["key", "type", "length", "memory", "TTL(ms)", "slot"],
        scan.top_keys.map((key) => [key.key, key.type, key.length ?? "-", byteCell(key.memory_bytes), key.ttl_ms, key.slot]),
      )}
      <h4>Stream TopN</h4>
      ${htmlTable(
        ["key", "XLEN", "memory", "TTL(ms)", "slot"],
        scan.top_streams.map((stream) => [stream.key, stream.length ?? "-", byteCell(stream.memory_bytes), stream.ttl_ms, stream.slot]),
      )}`;
}

function redisKeyDistributionHtml(scans: readonly RedisScan[]): string {
  if (scans.length === 0) return "";
  const options = scans.map((scan, index) => {
    const label = `${scan.node.host}:${scan.node.port} / db${scan.database}`;
    return `<option value="${index}">${escapeHtml(label)}</option>`;
  }).join("");
  const panels = scans.map((scan, index) => {
    const label = `${scan.node.host}:${scan.node.port} / db${scan.database}`;
    return `<div class="report-switcher-panel" data-switcher-value="${index}"${index === 0 ? "" : " hidden"}>
      <p class="report-switcher-title">${escapeHtml(label)}</p>
      ${redisScanDetailsHtml(scan)}
    </div>`;
  }).join("");
  return `<div class="report-switcher"><label>Master <select class="report-switcher-select" aria-label="选择 Redis master">${options}</select></label>${panels}</div>`;
}

function markdownInlineCode(value: string): string {
  const escaped = value.replaceAll("|", "\\|");
  const longestRun = Math.max(0, ...(escaped.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const padding = escaped.startsWith("`") || escaped.endsWith("`") ? " " : "";
  return `${fence}${padding}${escaped}${padding}${fence}`;
}

export function buildRedisMarkdown(
  target: RedisRenderTarget,
  diagnosis: RedisDiagnosis,
  options: RedisMarkdownOptions = {},
): string {
  const overview = redisOverview(diagnosis.evidence);
  const masters = redisMasters(diagnosis.evidence);
  const databases = redisDatabases(diagnosis.evidence);
  const nodes = redisNodes(diagnosis.evidence);
  const scans = redisScans(diagnosis.evidence);
  const keyStats = redisKeyStats(diagnosis.evidence);
  const configuredClusterType = diagnosis.evidence.facts.target.status === "collected"
    ? diagnosis.evidence.facts.target.configuredClusterType
    : "unknown";
  const lines: string[] = [
    "# Redis 诊断摘要",
    "",
    `- 目标: \`${target.endpoint}\`（${target.endpoint_source}）`,
    `- 拓扑类型: \`${overview?.clusterType ?? configuredClusterType}\``,
    `- 扫描模式: \`${overview?.scanMode ?? "未执行"}\`；深度扫描 \`db${overview?.selectedDatabase ?? 0}\`，仅扫描 master，replica 不重复扫描 key`,
    "",
    "## 诊断结论",
    "",
  ];
  if (diagnosis.findings.length === 0) {
    lines.push("- 本次采集未形成异常 Finding；是否足以排除目标问题见下方诊断覆盖度。");
  } else {
    for (const finding of diagnosis.findings) {
      lines.push(`- **${findingLabel(finding)}**：${describeRedisFinding(finding)}`);
    }
  }
  lines.push("", "## 诊断覆盖度", "", "| goal | status | missing evidence |", "|---|---|---|");
  for (const coverage of diagnosis.coverage) {
    lines.push(`| ${coverage.goal} | ${coverage.status} | ${coverage.missingEvidence.join("；") || "-"} |`);
  }

  if (overview?.clusterType === "sentinel" || overview?.clusterType === "cluster") {
    lines.push("", "## 实例 Key 数", "", "| node | role | database | keys | replication link |", "|---|---|---|---:|---|");
    for (const node of nodes) {
      const info = node.info ?? {};
      const link = node.error ? `error: ${node.error}` : String(info.master_link_status ?? "-");
      lines.push(`| ${node.host}:${node.port} | ${node.role} | db${node.selected_database} | ${node.dbsize ?? "-"} | ${link} |`);
    }
  }

  if (databases.length > 0) {
    lines.push("", "## Database 分布", "", "| master | database | keys | expires | average TTL |", "|---|---|---:|---:|---:|");
    for (const row of databases) {
      lines.push(`| ${row.node.host}:${row.node.port} | db${row.database.database} | ${row.database.keys} | ${row.database.expires} | ${row.database.average_ttl_ms} ms |`);
    }
  }

  lines.push("", "## Master 容量", "", "| node | used dataset | counted memory | maxmemory | usage | rss | fragmentation | AOF |", "|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const node of masters) {
    const info = node.info ?? {};
    const capacity = redisMemoryCapacity(node);
    lines.push(`| ${node.host}:${node.port} | ${formatBytes(info.used_memory_dataset)} | ${formatBytes(capacity?.usedBytes ?? info.used_memory)} | ${capacity ? formatBytes(capacity.maxBytes) : "unlimited"} | ${formatPercent(capacity?.utilization)} | ${formatBytes(info.used_memory_rss)} | ${info.mem_fragmentation_ratio ?? "-"} | ${formatBytes(info.aof_current_size)} |`);
  }

  lines.push("", "## 运行状态", "", "| node | version | maxmemory / policy | clients / blocked | ops/s | evicted | rejected | role/link |", "|---|---|---|---:|---:|---:|---:|---|");
  for (const node of nodes) {
    const info = node.info ?? {};
    const role = node.error ? `error: ${node.error}` : `${info.role ?? node.role}${info.master_link_status ? `/${info.master_link_status}` : ""}`;
    lines.push(`| ${node.host}:${node.port} | ${info.redis_version ?? "-"} | ${formatBytes(info.maxmemory)} / ${info.maxmemory_policy ?? "-"} | ${info.connected_clients ?? "-"} / ${info.blocked_clients ?? "-"} | ${info.instantaneous_ops_per_sec ?? "-"} | ${info.evicted_keys ?? "-"} | ${info.rejected_connections ?? "-"} | ${role} |`);
  }

  if (overview?.slotRanges.length) {
    const counts = new Map<string, number>();
    for (const range of overview.slotRanges) {
      const node = `${range.master.host}:${range.master.port}`;
      counts.set(node, (counts.get(node) ?? 0) + range.end - range.start + 1);
    }
    lines.push("", "## Slot 分布", "", "| master | slots |", "|---|---:|");
    for (const [node, count] of counts) lines.push(`| ${node} | ${count} |`);
  }

  for (const scan of scans) {
    const node = `${scan.node.host}:${scan.node.port}`;
    lines.push(
      "",
      `## Key 分布：${node} / db${scan.database}`,
      "",
      `已检查 ${scan.scanned_keys} 个 key，${scan.scan_complete ? "已扫完整个 keyspace" : "按完整 SCAN 游标分组随机采样"}；检查范围内内存 ${formatBytes(scan.sampled_memory_bytes)}，平均 ${formatBytes(scan.average_sampled_bytes_per_key)}/key。`,
      "",
      "### 类型 TopN",
      "",
      "| type | count | memory | no TTL | no TTL memory |",
      "|---|---:|---:|---:|---:|",
    );
    for (const row of scan.types) {
      lines.push(`| ${row.name} | ${row.count} | ${formatBytes(row.memory_bytes)} | ${row.no_ttl_count} | ${formatBytes(row.no_ttl_memory_bytes)} |`);
    }
    lines.push("", "### 前缀 TopN", "", "| prefix | count | memory | no TTL |", "|---|---:|---:|---:|");
    for (const row of scan.prefixes) {
      lines.push(`| ${markdownInlineCode(row.name)} | ${row.count} | ${formatBytes(row.memory_bytes)} | ${row.no_ttl_count} |`);
    }
    if (options.includeTtlTables !== false) {
      lines.push("", "### TTL 分布", "", "| bucket | count |", "|---|---:|");
      for (const [bucket, count] of Object.entries(scan.ttl_buckets)) {
        lines.push(`| ${bucket} | ${count} |`);
      }
    }
    if (scan.top_slots.length) {
      lines.push("", "### Slot TopN（按抽样内存）", "", "| slot | count | memory |", "|---:|---:|---:|");
      for (const slot of scan.top_slots) {
        lines.push(`| ${slot.slot} | ${slot.count} | ${formatBytes(slot.memory_bytes)} |`);
      }
    }
    if (scan.top_keys.length) {
      lines.push("", "### Big Key TopN", "", "| key | type | memory | TTL(ms) | slot |", "|---|---|---:|---:|---:|");
      for (const key of scan.top_keys) {
        lines.push(`| ${markdownInlineCode(key.key)} | ${key.type} | ${formatBytes(key.memory_bytes)} | ${key.ttl_ms} | ${key.slot} |`);
      }
    }
    if (scan.top_streams.length) {
      lines.push("", "### Stream TopN", "", "| key | XLEN | memory | TTL(ms) | slot |", "|---|---:|---:|---:|---:|");
      for (const stream of scan.top_streams) {
        lines.push(`| ${markdownInlineCode(stream.key)} | ${stream.length ?? "-"} | ${formatBytes(stream.memory_bytes)} | ${stream.ttl_ms} | ${stream.slot} |`);
      }
    }
  }

  for (const focused of keyStats) {
    const scan = focused.scan;
    const node = `${scan.node.host}:${scan.node.port}`;
    lines.push(
      "",
      `## Master keyStats：${node} / db${scan.database}`,
      "",
      focused.trigger === "forced"
        ? "已通过 --keystats 强制执行深度探测。"
        : `该 master 数据集内存是最小 master 的 ${focused.memoryRatio!.toFixed(2)}x，已触发独立深度探测。`,
      "",
      `已检查 ${scan.scanned_keys} 个 key，${scan.scan_complete ? "已扫完整个 keyspace" : "keyspace 超过全量预算，按完整 SCAN 游标扩大分组随机采样"}。`,
      "",
      "### Big Key TopN",
      "",
      "| key | type | length | memory | TTL(ms) | slot |",
      "|---|---|---:|---:|---:|---:|",
    );
    for (const key of scan.top_keys) {
      lines.push(`| ${markdownInlineCode(key.key)} | ${key.type} | ${key.length ?? "-"} | ${formatBytes(key.memory_bytes)} | ${key.ttl_ms} | ${key.slot} |`);
    }
  }

  lines.push("", "完整机器可读结果见 `raw/*-redis-probe.json`、`raw/*-redis-key-stats.json` 与 `raw/*-redis-pressure-*.json`，detector 结论见 `raw/*-redis-findings.json`，采集参数与来源见 `manifest.json`。", "");
  return lines.join("\n");
}

/** HTML 直接消费 Diagnosis；TTL 图表与表格都不从 Markdown 反向解析。 */
export function buildRedisHtml(target: RedisRenderTarget, diagnosis: RedisDiagnosis): string {
  const overview = redisOverview(diagnosis.evidence);
  const masters = redisMasters(diagnosis.evidence);
  const databases = redisDatabases(diagnosis.evidence);
  const nodes = redisNodes(diagnosis.evidence);
  const scans = redisScans(diagnosis.evidence);
  const configuredClusterType = diagnosis.evidence.facts.target.status === "collected"
    ? diagnosis.evidence.facts.target.configuredClusterType
    : "unknown";
  const parts = [
    htmlHeading(1, "Redis 诊断摘要"),
    htmlList([
      `目标: ${target.endpoint}（${target.endpoint_source}）`,
      `拓扑类型: ${overview?.clusterType ?? configuredClusterType}`,
      `扫描模式: ${overview?.scanMode ?? "未执行"}；深度扫描 db${overview?.selectedDatabase ?? 0}，仅扫描 master，replica 不重复扫描 key`,
    ]),
    htmlHeading(2, "容量状态"),
    redisCapacityStatus(diagnosis),
    htmlHeading(2, "诊断结论"),
    diagnosis.findings.length > 0
      ? htmlList(diagnosis.findings.map((finding) => `${findingLabel(finding)}：${describeRedisFinding(finding)}`))
      : htmlParagraph("本次采集未形成异常 Finding；是否足以排除目标问题见诊断覆盖度。"),
    htmlHeading(2, "诊断覆盖度"),
    htmlTable(
      ["goal", "status", "missing evidence"],
      diagnosis.coverage.map((coverage) => [
        coverage.goal,
        coverage.status,
        coverage.missingEvidence.join("；") || "-",
      ]),
    ),
  ];

  if (overview?.clusterType === "sentinel" || overview?.clusterType === "cluster") {
    parts.push(
      htmlHeading(2, "实例 Key 数"),
      htmlTable(
        ["node", "role", "database", "keys", "replication link"],
        nodes.map((node) => [
          `${node.host}:${node.port}`,
          node.role,
          `db${node.selected_database}`,
          node.dbsize ?? "-",
          node.error ? `error: ${node.error}` : String(node.info?.master_link_status ?? "-"),
        ]),
      ),
    );
  }

  if (databases.length > 0) {
    parts.push(
      htmlHeading(2, "Database 分布"),
      htmlTable(
        ["master", "database", "keys", "expires", "average TTL"],
        databases.map((row) => [
          `${row.node.host}:${row.node.port}`,
          `db${row.database.database}`,
          row.database.keys,
          row.database.expires,
          `${row.database.average_ttl_ms} ms`,
        ]),
      ),
    );
  }

  parts.push(
    htmlHeading(2, "Master 容量"),
    htmlTable(
      ["node", "used dataset", "counted memory", "maxmemory", "usage", "rss", "fragmentation", "AOF"],
      masters.map((node) => {
        const capacity = redisMemoryCapacity(node);
        return [
          `${node.host}:${node.port}`,
          byteCell(node.info?.used_memory_dataset),
          byteCell(capacity?.usedBytes ?? node.info?.used_memory),
          capacity ? byteCell(capacity.maxBytes) : "unlimited",
          capacity ? htmlTableCell(formatPercent(capacity.utilization), capacity.utilization) : "-",
          byteCell(node.info?.used_memory_rss),
          node.info?.mem_fragmentation_ratio ?? "-",
          byteCell(node.info?.aof_current_size),
        ];
      }),
    ),
    htmlHeading(2, "运行状态"),
    htmlTable(
      ["node", "version", "maxmemory / policy", "clients / blocked", "ops/s", "evicted", "rejected", "role/link"],
      nodes.map((node) => [
        `${node.host}:${node.port}`,
        node.info?.redis_version ?? "-",
        `${formatBytes(node.info?.maxmemory)} / ${node.info?.maxmemory_policy ?? "-"}`,
        `${node.info?.connected_clients ?? "-"} / ${node.info?.blocked_clients ?? "-"}`,
        node.info?.instantaneous_ops_per_sec ?? "-",
        node.info?.evicted_keys ?? "-",
        node.info?.rejected_connections ?? "-",
        node.error
          ? `error: ${node.error}`
          : `${node.info?.role ?? node.role}${node.info?.master_link_status ? `/${node.info.master_link_status}` : ""}`,
      ]),
    ),
  );

  if (overview?.slotRanges.length) {
    const counts = new Map<string, number>();
    for (const range of overview.slotRanges) {
      const node = `${range.master.host}:${range.master.port}`;
      counts.set(node, (counts.get(node) ?? 0) + range.end - range.start + 1);
    }
    parts.push(htmlHeading(2, "Slot 分布"), htmlTable(["master", "slots"], [...counts.entries()]));
  }

  return parts.join("\n");
}

export function buildRedisKeyDistributionHtml(diagnosis: RedisDiagnosis): string {
  return redisKeyDistributionHtml(redisScans(diagnosis.evidence));
}

export function buildRedisKeyStatsHtml(diagnosis: RedisDiagnosis): string {
  return redisKeyDistributionHtml(redisKeyStats(diagnosis.evidence).map((item) => item.scan));
}

const TTL_ORDER = ["no_ttl", "le_1h", "le_1d", "le_7d", "gt_7d", "expired_or_missing"];
const TTL_LABELS: Record<string, string> = {
  no_ttl: "无 TTL",
  le_1h: "≤ 1 小时",
  le_1d: "≤ 1 天",
  le_7d: "≤ 7 天",
  gt_7d: "> 7 天",
  expired_or_missing: "已过期/不存在",
};

export function buildRedisTtlPieCharts(diagnosis: RedisDiagnosis): HtmlPieChart[] {
  return redisScans(diagnosis.evidence).map((scan) => {
    const keys = [
      ...TTL_ORDER.filter((key) => key in scan.ttl_buckets),
      ...Object.keys(scan.ttl_buckets).filter((key) => !TTL_ORDER.includes(key)),
    ];
    return {
      title: `${scan.node.host}:${scan.node.port} / db${scan.database}`,
      slices: keys.map((key) => ({ label: TTL_LABELS[key] ?? key, value: scan.ttl_buckets[key] ?? 0 })),
    };
  });
}
