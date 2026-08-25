import {
  escapeHtml,
  htmlBarChart,
  htmlPieCharts,
  htmlProgressMetrics,
  htmlTable,
  htmlTableCell,
  type HtmlReportSection,
} from "../../output/html";
import type { StoreConfig } from "../config";
import type { S3InspectionFacts } from "./fact/model";
import type { S3BucketInventory, S3Observations } from "./model";

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function formatTimestamp(value: string | undefined): string {
  return value?.replace("T", " ").replace(/\.\d{3}Z$/, " UTC") ?? "n/a";
}

function focusDescription(bucket: S3BucketInventory): string {
  return bucket.serviceFocus
    ? `<p class="muted">Service 关注：<code>${escapeHtml(bucket.bucket)}${bucket.focusPrefix ? `/${escapeHtml(bucket.focusPrefix)}` : ""}</code>；关注 Prefix 已优先采集。</p>`
    : "";
}

function prefixDistributionDescription(
  bucket: S3BucketInventory,
  ranking: "capacity" | "objects",
): string {
  const scope = bucket.scopePrefix || "(whole bucket)";
  if (bucket.prefixMode === "top-n") {
    const rows = ranking === "capacity"
      ? bucket.firstLevelPrefixes
      : bucket.firstLevelPrefixesByObjects;
    return `scope=${scope} · 发现 ${bucket.discoveredFirstLevelPrefixes} 个一级 Prefix · 公平采样 · ${ranking === "capacity" ? "容量" : "Object 数量"} Top ${rows.length}`;
  }
  return `scope=${scope} · ${bucket.status === "complete" ? "完整扫描" : "部分扫描"} ${bucket.discoveredFirstLevelPrefixes} 个一级 Prefix`;
}

function renderPrefixDetail(bucket: S3BucketInventory, prefixIndex: number): string {
  const prefix = bucket.firstLevelPrefixes[prefixIndex]!;
  const objectBasis = prefix.status === "complete" ? "全量 Object" : "采样 Object";
  const statusDescription = prefix.status === "complete"
    ? "该 Prefix 已完整扫描"
    : prefix.status === "sampled"
      ? "该 Prefix 为公平采样结果，容量与占比仅代表样本"
      : "扫描受总对象数或时间预算限制，容量与占比仅代表已扫描对象";
  return `<p class="report-switcher-title"><code>${escapeHtml(bucket.bucket)}/${escapeHtml(prefix.prefix)}</code></p>
    <p class="muted">${statusDescription} · ${prefix.objects} objects / ${formatBytes(prefix.bytes)} · 最近修改 ${formatTimestamp(prefix.latestLastModified)}</p>
    <div class="chart-grid">
      <article><h3>第二级 Prefix（Top ${prefix.secondLevelPrefixes.length}）</h3>${htmlBarChart(prefix.secondLevelPrefixes.map((row) => ({
        label: row.prefix,
        value: row.bytes,
        valueLabel: formatBytes(row.bytes),
        detail: `${row.objects} objects · 当前一级 Prefix 样本的 ${prefix.bytes > 0 ? (row.bytes * 100 / prefix.bytes).toFixed(1) : "0.0"}% · 最近修改 ${formatTimestamp(row.latestLastModified)}`,
      })))}</article>
      <article><h3>${objectBasis} Top ${prefix.topObjects.length}</h3>${htmlBarChart(prefix.topObjects.map((row) => ({
        label: row.key,
        value: row.bytes,
        valueLabel: formatBytes(row.bytes),
        detail: `最近修改 ${formatTimestamp(row.lastModified)}`,
      })))}</article>
    </div>
    ${htmlPieCharts([
      {
        title: `${objectBasis} 年龄分布`,
        description: "按逻辑容量统计",
        slices: prefix.ageDistribution.map((row) => ({
          label: `${row.range} (${row.objects})`,
          value: row.bytes,
          valueLabel: formatBytes(row.bytes),
        })),
      },
      {
        title: `${objectBasis} 文件扩展名分布`,
        description: "按逻辑容量统计；只展示容量 Top 10 扩展名",
        slices: prefix.extensionDistribution.map((row) => ({
          label: `${row.extension} (${row.objects})`,
          value: row.bytes,
          valueLabel: formatBytes(row.bytes),
        })),
      },
    ])}`;
}

export function buildS3HtmlReport(observations: S3Observations): {
  sections: HtmlReportSection[];
} {
  const capacity = observations.capacity;
  const driveCapacity = observations.driveCapacity;
  const inventory = observations.inventory;
  const physicalCapacityHtml = capacity
    ? htmlProgressMetrics([{
        title: capacity.title,
        value: capacity.rawUsageBytes,
        max: capacity.rawCapacityBytes,
        valueLabel: formatBytes(capacity.rawUsageBytes),
        maxLabel: formatBytes(capacity.rawCapacityBytes),
        status: capacity.rawUsagePercent >= 90
          ? "容量瓶颈已确认"
          : capacity.rawUsagePercent >= 80 ? "容量偏高" : "容量正常",
        details: [`剩余 ${formatBytes(capacity.rawFreeBytes)}`],
        tone: capacity.rawUsagePercent >= 90
          ? "critical"
          : capacity.rawUsagePercent >= 80 ? "warning" : "normal",
      }])
    : `<p class="muted">当前 S3 Provider 未提供物理容量指标。</p>`;

  const inodeExhausted = driveCapacity?.drives.filter(
    (drive) => drive.freeInodes < driveCapacity.minimumFreeInodes,
  ) ?? [];
  const driveCapacityHtml = driveCapacity
    ? `<p class="${inodeExhausted.length ? "metric-status-critical" : "muted"}">${inodeExhausted.length
        ? `${inodeExhausted.length}/${driveCapacity.drives.length} 块盘低于 ${driveCapacity.minimumFreeInodes} free inode 写入阈值。`
        : `${driveCapacity.drives.length} 块盘均高于 ${driveCapacity.minimumFreeInodes} free inode 写入阈值。`}</p>${htmlTable(
        ["状态", "Drive", "Free inode", "Inode 使用率", "Free bytes"],
        driveCapacity.drives.map((drive) => {
          const exhausted = drive.freeInodes < driveCapacity.minimumFreeInodes;
          return [
            exhausted ? "写入受阻" : "正常",
            drive.drive,
            htmlTableCell(drive.freeInodes.toLocaleString("en-US"), drive.freeInodes),
            htmlTableCell(
              `${(drive.usedInodes / drive.totalInodes * 100).toFixed(2)}%`,
              drive.usedInodes / drive.totalInodes * 100,
            ),
            htmlTableCell(formatBytes(drive.freeBytes), drive.freeBytes),
          ];
        }),
        { search: { column: 1, placeholder: "检索 Drive" } },
      )}`
    : `<p class="muted">当前 S3 Provider 未提供逐盘 byte/inode 指标。</p>`;

  const scannedByBucket = new Map(inventory?.buckets.map((bucket) => [bucket.bucket, bucket]) ?? []);
  const accessible = new Set(observations.bucketAccess?.buckets ?? []);
  const metricBuckets = observations.bucketUsage?.buckets
    .filter((row) => accessible.size === 0 || accessible.has(row.bucket)) ?? [];
  const inventoryBuckets = [...scannedByBucket.values()];
  const bucketRows = inventoryBuckets.length
    ? inventoryBuckets.map((row) => ({
        bucket: row.bucket,
        bytes: row.bytes,
        objects: row.objects,
        sinceLastUpdateSeconds: undefined,
        source: row.status === "complete" ? "对象完整扫描" : "对象部分扫描",
      }))
    : metricBuckets.map((row) => ({
        ...row,
        source: `${observations.bucketUsage!.providerDisplayName} Metrics（回退）`,
      }));
  bucketRows.sort((left, right) => right.bytes - left.bytes || left.bucket.localeCompare(right.bucket));
  const topBuckets = bucketRows.slice(0, 10);
  const otherBytes = bucketRows.slice(10).reduce((sum, row) => sum + row.bytes, 0);
  const bucketCapacityHtml = topBuckets.length
    ? `<div class="chart-grid"><article>${htmlBarChart(topBuckets.map((row) => ({
        label: row.bucket,
        value: row.bytes,
        valueLabel: formatBytes(row.bytes),
        detail: `${row.objects ?? "n/a"} objects · ${row.source}${row.sinceLastUpdateSeconds === undefined ? "" : ` · ${Math.round(row.sinceLastUpdateSeconds)}s 前更新`}`,
      })))}</article>${htmlPieCharts([{
        title: "Bucket 对象占用占比",
        description: inventoryBuckets.length
          ? "与 Prefix 图使用同一次 ListObjectsV2 扫描；部分扫描只代表已扫描对象"
          : `${observations.bucketUsage!.providerDisplayName} Bucket Usage Metrics（未取得对象扫描，作为回退）`,
        slices: [
          ...topBuckets.map((row) => ({
            label: row.bucket,
            value: row.bytes,
            valueLabel: formatBytes(row.bytes),
          })),
          ...(otherBytes > 0 ? [{ label: "其它", value: otherBytes, valueLabel: formatBytes(otherBytes) }] : []),
        ],
      }])}</div>`
    : `<p class="muted">未取得 Bucket 容量数据。</p>`;

  const bucketOptions = inventory?.buckets.map((bucket, index) =>
    `<option value="${index}">${escapeHtml(bucket.bucket)}${bucket.serviceFocus ? "（Service 关注）" : ""}</option>`
  ).join("") ?? "";
  const prefixDistributionPanels = inventory?.buckets.map((bucket, index) =>
    `<div class="report-switcher-panel" data-switcher-value="${index}"${index === 0 ? "" : " hidden"}>${focusDescription(bucket)}${htmlPieCharts([
      {
        title: `${bucket.bucket} 一级 Prefix 容量占比`,
        description: prefixDistributionDescription(bucket, "capacity"),
        slices: [
          ...bucket.firstLevelPrefixes.map((prefix) => ({
            label: prefix.prefix,
            value: prefix.bytes,
            valueLabel: `${formatBytes(prefix.bytes)} · ${prefix.objects.toLocaleString("en-US")} objects`,
          })),
          ...(bucket.otherFirstLevelPrefixes
            ? [{
                label: `其它一级 Prefix（${bucket.otherFirstLevelPrefixes.prefixes}）`,
                value: bucket.otherFirstLevelPrefixes.bytes,
                valueLabel: `${formatBytes(bucket.otherFirstLevelPrefixes.bytes)} · ${bucket.otherFirstLevelPrefixes.objects.toLocaleString("en-US")} objects`,
              }]
            : []),
        ],
      },
      {
        title: `${bucket.bucket} 一级 Prefix Object 数量占比`,
        description: prefixDistributionDescription(bucket, "objects"),
        slices: [
          ...bucket.firstLevelPrefixesByObjects.map((prefix) => ({
            label: prefix.prefix,
            value: prefix.objects,
            valueLabel: `${prefix.objects.toLocaleString("en-US")} objects · ${formatBytes(prefix.bytes)}`,
          })),
          ...(bucket.otherFirstLevelPrefixesByObjects
            ? [{
                label: `其它一级 Prefix（${bucket.otherFirstLevelPrefixesByObjects.prefixes}）`,
                value: bucket.otherFirstLevelPrefixesByObjects.objects,
                valueLabel: `${bucket.otherFirstLevelPrefixesByObjects.objects.toLocaleString("en-US")} objects · ${formatBytes(bucket.otherFirstLevelPrefixesByObjects.bytes)}`,
              }]
            : []),
        ],
      },
    ])}<p class="muted">${escapeHtml(bucket.note)}</p></div>`
  ).join("") ?? "";
  const prefixDistributionHtml = inventory?.buckets.length
    ? `<div class="report-switcher"><label>Bucket <select class="report-switcher-select" aria-label="选择 S3 Bucket">${bucketOptions}</select></label>${prefixDistributionPanels}</div>`
    : `<p class="muted">未取得一级 Prefix 容量与 Object 数量数据。</p>`;

  const detailBuckets = inventory?.buckets
    .map((bucket, bucketIndex) => ({ bucket, bucketIndex }))
    .filter(({ bucket }) => bucket.firstLevelPrefixes.length > 0) ?? [];
  const cascadeBucketOptions = detailBuckets.map(({ bucket, bucketIndex }) =>
    `<option value="${bucketIndex}">${escapeHtml(bucket.bucket)}${bucket.serviceFocus ? "（Service 关注）" : ""}</option>`
  ).join("");
  const firstBucketIndex = detailBuckets[0]?.bucketIndex;
  const cascadePrefixOptions = detailBuckets.flatMap(({ bucket, bucketIndex }) =>
    bucket.firstLevelPrefixes.map((prefix, prefixIndex) => {
      const value = `${bucketIndex}:${prefixIndex}`;
      const visible = bucketIndex === firstBucketIndex;
      return `<option value="${value}" data-cascade-parent="${bucketIndex}"${visible ? "" : " hidden disabled"}>${escapeHtml(prefix.prefix)}</option>`;
    })
  ).join("");
  const detailPanels = detailBuckets.flatMap(({ bucket, bucketIndex }) =>
    bucket.firstLevelPrefixes.map((_, prefixIndex) => {
      const value = `${bucketIndex}:${prefixIndex}`;
      const visible = bucketIndex === firstBucketIndex && prefixIndex === 0;
      return `<div class="report-cascade-panel" data-cascade-parent="${bucketIndex}" data-cascade-value="${value}"${visible ? "" : " hidden"}>${renderPrefixDetail(bucket, prefixIndex)}</div>`;
    })
  ).join("");
  const prefixDetailHtml = detailBuckets.length
    ? `<div class="report-cascade-switcher"><div class="report-switcher-controls"><label>Bucket <select class="report-cascade-parent-select report-switcher-select" aria-label="选择 S3 Bucket">${cascadeBucketOptions}</select></label><label>一级 Prefix <select class="report-cascade-child-select report-switcher-select" aria-label="选择一级 Prefix">${cascadePrefixOptions}</select></label></div>${detailPanels}</div>`
    : `<p class="muted">未取得可供分析的 Prefix Object 数据。</p>`;

  return {
    sections: [
      { title: "物理容量", html: physicalCapacityHtml },
      { title: "逐盘写入容量", html: driveCapacityHtml },
      { title: "Bucket 容量分布", html: bucketCapacityHtml },
      { title: "Prefix 容量与文件数分布", html: prefixDistributionHtml },
      { title: "Prefix 下一级 Object 分布", html: prefixDetailHtml },
    ],
  };
}

export function buildS3Summary(config: StoreConfig, facts: S3InspectionFacts, observations: S3Observations): string {
  const access = observations.bucketAccess;
  const health = observations.providerHealth;
  const capacity = observations.capacity;
  const driveCapacity = observations.driveCapacity;
  const inventory = observations.inventory;
  const bucket = facts.configuration.status === "collected" ? facts.configuration.bucket : "unknown";
  const providerHealthy = !health || Object.values(health.endpoints).every((status) => status === 200);
  const providerName = facts.provider.status === "collected" ? facts.provider.displayName : "未识别";
  const capacityLine = capacity
    ? `${formatBytes(capacity.rawUsageBytes)} / ${formatBytes(capacity.rawCapacityBytes)}（${capacity.rawUsagePercent.toFixed(1)}%，剩余 ${formatBytes(capacity.rawFreeBytes)}）`
    : "未取得";
  const inodeExhausted = driveCapacity?.drives.filter(
    (drive) => drive.freeInodes < driveCapacity.minimumFreeInodes,
  ) ?? [];
  const driveCapacityLine = driveCapacity
    ? inodeExhausted.length
      ? `${inodeExhausted.length}/${driveCapacity.drives.length} 块盘低于 ${driveCapacity.minimumFreeInodes} free inode 写入阈值`
      : `${driveCapacity.drives.length} 块盘均高于 ${driveCapacity.minimumFreeInodes} free inode 写入阈值`
    : "未取得";
  const inventoryLines = inventory
    ? [
        `- Bucket Prefix 画像: **${inventory.scannedBuckets}/${inventory.discoveredBuckets}**`,
        ...inventory.buckets.map((row) => `  - \`${row.bucket}\`${row.serviceFocus ? "（Service 关注）" : ""}: **${row.status === "complete" ? "完整" : "部分"}**，scope=\`${row.scopePrefix || "(whole bucket)"}\`，${row.objects} objects / ${formatBytes(row.bytes)}；一级 Prefix 容量 ${row.prefixMode === "top-n" ? `采样 Top ${row.firstLevelPrefixes.length}/${row.discoveredFirstLevelPrefixes}` : `${row.firstLevelPrefixes.length}`}：${row.firstLevelPrefixes.slice(0, 3).map((prefix) => `\`${prefix.prefix}\` ${formatBytes(prefix.bytes)}`).join("、") || "n/a"}；Object 数量 Top ${Math.min(3, row.firstLevelPrefixesByObjects.length)}：${row.firstLevelPrefixesByObjects.slice(0, 3).map((prefix) => `\`${prefix.prefix}\` ${prefix.objects.toLocaleString("en-US")}`).join("、") || "n/a"}`),
        ...(inventory.buckets.some((row) => row.status === "partial") ? ["- 注意: 部分画像只代表已扫描或采样对象，不能外推为全桶分布。"] : []),
      ]
    : ["- Prefix 画像: **失败或未取得**"];
  const usageLine = inventory
    ? inventory.buckets.slice(0, 5).map((row) => `\`${row.bucket}\` ${formatBytes(row.bytes)}`).join("；")
    : "未取得";
  return [
    "# S3 Store 诊断摘要",
    "",
    `- Service: \`${config.service}\``,
    `- Store: \`${config.capability.id}\``,
    `- Service 关注 Bucket: \`${bucket}\`${facts.configuration.status === "collected" && facts.configuration.bucketPrefix ? `，Prefix=\`${facts.configuration.bucketPrefix}\`` : ""}`,
    `- 凭证可见 Bucket: **${access?.buckets.length ?? 0}**${access?.discovery === "configured-bucket-fallback" ? "（ListBuckets 无权限，仅回退到 Service Bucket）" : ""}`,
    `- Bucket 访问: **${access ? (access.ok ? "正常" : `异常（HTTP ${access.httpStatus}）`) : "未取得"}**`,
    `- Provider: **${providerName}**`,
    `- Provider 健康: **${health ? (providerHealthy ? "正常" : "异常") : "未取得扩展健康信息"}**`,
    `- 物理容量: **${capacityLine}**`,
    `- 逐盘写入容量: **${driveCapacityLine}**`,
    `- Top Bucket 对象占用: ${usageLine}`,
    ...inventoryLines,
    "",
  ].join("\n");
}
