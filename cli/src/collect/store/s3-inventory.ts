import {
  listObjectsV2,
  type S3ObjectMetadata,
  type S3ObjectPage,
  type S3Target,
} from "../../infra/object-store";

const AGE_THRESHOLDS_DAYS = [7, 30, 90, 365] as const;
const AGE_RANGES = ["<7d", "7-30d", "30-90d", "90-365d", ">=365d"] as const;
export const FIRST_LEVEL_PREFIX_FULL_SCAN_THRESHOLD = 20;
export const S3_PREFIX_TOP_N = 10;
const PREFIX_SAMPLE_MAX_OBJECTS = 100;

interface AggregateRow {
  objects: number;
  bytes: number;
}

export interface S3PrefixAggregateUsage extends AggregateRow {
  prefix: string;
}

interface PrefixRow extends AggregateRow {
  latestLastModified?: Date;
}

interface PrefixAggregate extends PrefixRow {
  secondLevelPrefixes: Map<string, PrefixRow>;
  sampledObjects: S3ObjectMetadata[];
}

export interface S3PrefixUsage extends AggregateRow {
  prefix: string;
  status: "complete" | "partial" | "sampled";
  latestLastModified?: string;
  secondLevelPrefixes: Array<AggregateRow & { prefix: string; latestLastModified?: string }>;
  topObjects: S3ObjectUsage[];
  ageDistribution: Array<AggregateRow & { range: string }>;
  extensionDistribution: Array<AggregateRow & { extension: string }>;
}

export interface S3ObjectUsage {
  key: string;
  bytes: number;
  lastModified: string;
}

export interface S3InventorySummary {
  status: "complete" | "partial";
  scopePrefix: string;
  pages: number;
  objects: number;
  bytes: number;
  oldestLastModified?: string;
  newestLastModified?: string;
  ageDistribution: Array<AggregateRow & { range: string }>;
  reclaimable: Array<AggregateRow & { olderThanDays: number }>;
  prefixMode: "all" | "top-n";
  discoveredFirstLevelPrefixes: number;
  firstLevelPrefixes: S3PrefixUsage[];
  otherFirstLevelPrefixes?: AggregateRow & { prefixes: number };
  firstLevelPrefixesByObjects: S3PrefixAggregateUsage[];
  otherFirstLevelPrefixesByObjects?: AggregateRow & { prefixes: number };
  topObjects: S3ObjectUsage[];
  stoppedReason?: "object-limit" | "time-limit";
  note: string;
}

function add(row: AggregateRow, size: number): void {
  row.objects += 1;
  row.bytes += size;
}

function addPrefixObject(row: PrefixRow, object: S3ObjectMetadata): void {
  add(row, object.size);
  if (!row.latestLastModified || object.lastModified > row.latestLastModified) {
    row.latestLastModified = object.lastModified;
  }
}

function prefixGroups(key: string, scopePrefix: string): { prefix: string; secondLevelPrefix: string } {
  let relative = scopePrefix && key.startsWith(scopePrefix)
    ? key.slice(scopePrefix.length)
    : key;
  relative = relative.replace(/^\/+/, "");
  const firstSeparator = relative.indexOf("/");
  const segment = firstSeparator >= 0 ? relative.slice(0, firstSeparator) : "";
  const base = scopePrefix.replace(/\/+$/, "");
  const prefix = segment ? (base ? `${base}/${segment}` : segment) : base || "(bucket-root)";
  const remainder = segment ? relative.slice(firstSeparator + 1) : relative;
  const separator = remainder.indexOf("/");
  const secondLevelPrefix = separator > 0
    ? `${prefix}/${remainder.slice(0, separator)}`
    : `${prefix}/(direct objects)`;
  return { prefix, secondLevelPrefix };
}

function ageRange(ageDays: number): string {
  if (ageDays < 7) return "<7d";
  if (ageDays < 30) return "7-30d";
  if (ageDays < 90) return "30-90d";
  if (ageDays < 365) return "90-365d";
  return ">=365d";
}

function ageDistribution(
  objects: readonly S3ObjectMetadata[],
  now: Date,
): Array<AggregateRow & { range: string }> {
  const rows = new Map<string, AggregateRow>(
    AGE_RANGES.map((range) => [range, { objects: 0, bytes: 0 }]),
  );
  for (const object of objects) {
    const ageDays = Math.max(0, (now.getTime() - object.lastModified.getTime()) / 86_400_000);
    add(rows.get(ageRange(ageDays))!, object.size);
  }
  return [...rows].map(([range, row]) => ({ range, ...row }));
}

function objectExtension(key: string): string {
  const filename = key.split("/").at(-1) ?? "";
  const dot = filename.lastIndexOf(".");
  return dot > 0 && dot < filename.length - 1
    ? filename.slice(dot).toLocaleLowerCase()
    : "(无扩展名)";
}

function extensionDistribution(
  objects: readonly S3ObjectMetadata[],
): Array<AggregateRow & { extension: string }> {
  const rows = new Map<string, AggregateRow>();
  for (const object of objects) {
    const extension = objectExtension(object.key);
    const row = rows.get(extension) ?? { objects: 0, bytes: 0 };
    add(row, object.size);
    rows.set(extension, row);
  }
  return [...rows]
    .map(([extension, row]) => ({ extension, ...row }))
    .sort((left, right) => right.bytes - left.bytes || right.objects - left.objects)
    .slice(0, S3_PREFIX_TOP_N);
}

function topObjects(objects: readonly S3ObjectMetadata[]): S3ObjectUsage[] {
  return [...objects]
    .sort((left, right) => right.size - left.size || left.key.localeCompare(right.key))
    .slice(0, S3_PREFIX_TOP_N)
    .map((object) => ({
      key: object.key,
      bytes: object.size,
      lastModified: object.lastModified.toISOString(),
    }));
}

export function summarizeS3Objects(input: {
  objects: readonly S3ObjectMetadata[];
  scopePrefix?: string;
  now?: Date;
  complete: boolean;
  pages: number;
  stoppedReason?: "object-limit" | "time-limit";
  prefixMode?: "all" | "top-n";
  discoveredFirstLevelPrefixes?: number;
}): S3InventorySummary {
  const scopePrefix = input.scopePrefix ?? "";
  const now = input.now ?? new Date();
  const reclaimableRows = new Map<number, AggregateRow>(
    AGE_THRESHOLDS_DAYS.map((days) => [days, { objects: 0, bytes: 0 }]),
  );
  const prefixRows = new Map<string, PrefixAggregate>();
  let bytes = 0;
  let oldest: Date | undefined;
  let newest: Date | undefined;
  for (const object of input.objects) {
    bytes += object.size;
    if (!oldest || object.lastModified < oldest) oldest = object.lastModified;
    if (!newest || object.lastModified > newest) newest = object.lastModified;
    const ageDays = Math.max(0, (now.getTime() - object.lastModified.getTime()) / 86_400_000);
    for (const [days, row] of reclaimableRows) {
      if (ageDays >= days) add(row, object.size);
    }
    const { prefix, secondLevelPrefix } = prefixGroups(object.key, scopePrefix);
    const row: PrefixAggregate = prefixRows.get(prefix) ?? {
      objects: 0,
      bytes: 0,
      secondLevelPrefixes: new Map(),
      sampledObjects: [],
    };
    addPrefixObject(row, object);
    row.sampledObjects.push(object);
    const secondLevelRow = row.secondLevelPrefixes.get(secondLevelPrefix) ?? { objects: 0, bytes: 0 };
    addPrefixObject(secondLevelRow, object);
    row.secondLevelPrefixes.set(secondLevelPrefix, secondLevelRow);
    prefixRows.set(prefix, row);
  }
  const discoveredFirstLevelPrefixes = input.discoveredFirstLevelPrefixes ?? prefixRows.size;
  const prefixMode = input.prefixMode
    ?? (discoveredFirstLevelPrefixes > FIRST_LEVEL_PREFIX_FULL_SCAN_THRESHOLD ? "top-n" : "all");
  const prefixStatus: S3PrefixUsage["status"] = input.complete
    ? "complete"
    : prefixMode === "top-n" ? "sampled" : "partial";
  const firstLevelPrefixes = [...prefixRows]
    .map(([prefix, row]) => ({
      prefix,
      status: prefixStatus,
      objects: row.objects,
      bytes: row.bytes,
      latestLastModified: row.latestLastModified?.toISOString(),
      secondLevelPrefixes: [...row.secondLevelPrefixes]
        .map(([secondLevelPrefix, aggregate]) => ({
          prefix: secondLevelPrefix,
          objects: aggregate.objects,
          bytes: aggregate.bytes,
          latestLastModified: aggregate.latestLastModified?.toISOString(),
        }))
        .sort((left, right) => right.bytes - left.bytes || right.objects - left.objects)
        .slice(0, S3_PREFIX_TOP_N),
      topObjects: topObjects(row.sampledObjects),
      ageDistribution: ageDistribution(row.sampledObjects, now),
      extensionDistribution: extensionDistribution(row.sampledObjects),
    }))
    .sort((left, right) => right.bytes - left.bytes || right.objects - left.objects);
  const selectedFirstLevelPrefixes = prefixMode === "top-n"
    ? firstLevelPrefixes.slice(0, S3_PREFIX_TOP_N)
    : firstLevelPrefixes;
  const omittedFirstLevelPrefixes = prefixMode === "top-n"
    ? firstLevelPrefixes.slice(S3_PREFIX_TOP_N)
    : [];
  const firstLevelPrefixesByObjects = firstLevelPrefixes
    .map(({ prefix, objects, bytes }) => ({ prefix, objects, bytes }))
    .sort((left, right) => right.objects - left.objects || right.bytes - left.bytes);
  const selectedFirstLevelPrefixesByObjects = prefixMode === "top-n"
    ? firstLevelPrefixesByObjects.slice(0, S3_PREFIX_TOP_N)
    : firstLevelPrefixesByObjects;
  const omittedFirstLevelPrefixesByObjects = prefixMode === "top-n"
    ? firstLevelPrefixesByObjects.slice(S3_PREFIX_TOP_N)
    : [];
  return {
    status: input.complete ? "complete" : "partial",
    scopePrefix,
    pages: input.pages,
    objects: input.objects.length,
    bytes,
    oldestLastModified: oldest?.toISOString(),
    newestLastModified: newest?.toISOString(),
    ageDistribution: ageDistribution(input.objects, now),
    reclaimable: [...reclaimableRows].map(([olderThanDays, row]) => ({ olderThanDays, ...row })),
    prefixMode,
    discoveredFirstLevelPrefixes,
    firstLevelPrefixes: selectedFirstLevelPrefixes,
    otherFirstLevelPrefixes: omittedFirstLevelPrefixes.length
      ? {
          prefixes: omittedFirstLevelPrefixes.length,
          objects: omittedFirstLevelPrefixes.reduce((sum, row) => sum + row.objects, 0),
          bytes: omittedFirstLevelPrefixes.reduce((sum, row) => sum + row.bytes, 0),
        }
      : undefined,
    firstLevelPrefixesByObjects: selectedFirstLevelPrefixesByObjects,
    otherFirstLevelPrefixesByObjects: omittedFirstLevelPrefixesByObjects.length
      ? {
          prefixes: omittedFirstLevelPrefixesByObjects.length,
          objects: omittedFirstLevelPrefixesByObjects.reduce((sum, row) => sum + row.objects, 0),
          bytes: omittedFirstLevelPrefixesByObjects.reduce((sum, row) => sum + row.bytes, 0),
        }
      : undefined,
    topObjects: topObjects(input.objects),
    stoppedReason: input.stoppedReason,
    note: input.complete
      ? prefixMode === "top-n"
        ? `已完整扫描当前 scope；报告分别展示容量和 Object 数量 Top ${S3_PREFIX_TOP_N} 一级 Prefix`
        : "统计覆盖当前 scope 下 ListObjectsV2 返回的全部当前对象版本"
      : prefixMode === "top-n"
        ? `一级 Prefix 超过 ${FIRST_LEVEL_PREFIX_FULL_SCAN_THRESHOLD} 个；结果按 Prefix 公平采样并分别展示样本容量和 Object 数量 Top ${S3_PREFIX_TOP_N}`
        : "扫描受对象数或时间预算限制；结果只代表已扫描对象",
  };
}

export async function scanS3Objects(input: {
  target: S3Target;
  prefix?: string;
  priorityPrefix?: string;
  maxObjects: number;
  timeoutMs: number;
  now?: Date;
  onProgress?: (objects: number, pages: number) => void;
}): Promise<S3InventorySummary> {
  const startedAt = Date.now();
  const objects = new Map<string, S3ObjectMetadata>();
  let pages = 0;
  let stoppedReason: "object-limit" | "time-limit" | undefined;
  const deadline = startedAt + input.timeoutMs;

  const addPage = (page: S3ObjectPage): void => {
    pages += 1;
    for (const object of page.objects) objects.set(object.key, object);
    input.onProgress?.(objects.size, pages);
  };
  const requestPage = async (options: {
    prefix?: string;
    delimiter?: string;
    continuationToken?: string;
    maxKeys?: number;
  }): Promise<S3ObjectPage | undefined> => {
    const remaining = input.maxObjects - objects.size;
    if (remaining <= 0) {
      stoppedReason = "object-limit";
      return undefined;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      stoppedReason = "time-limit";
      return undefined;
    }
    try {
      return await listObjectsV2(input.target, {
        ...options,
        maxKeys: Math.min(options.maxKeys ?? 1000, remaining),
        timeoutMs: Math.min(10_000, remainingMs),
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
      stoppedReason = "time-limit";
      return undefined;
    }
  };

  let complete = false;
  let prefixMode: "all" | "top-n" | undefined;
  let discoveredFirstLevelPrefixes: number | undefined;
  if (input.prefix) {
    let continuationToken: string | undefined;
    do {
      const page = await requestPage({ prefix: input.prefix, continuationToken });
      if (!page) break;
      addPage(page);
      if (!page.isTruncated) {
        complete = true;
        break;
      }
      continuationToken = page.nextContinuationToken;
    } while (continuationToken);
  } else {
    const rootPrefixes: string[] = [];
    let rootContinuationToken: string | undefined;
    let rootComplete = false;
    do {
      const page = await requestPage({ delimiter: "/", continuationToken: rootContinuationToken });
      if (!page) break;
      addPage(page);
      rootPrefixes.push(...page.commonPrefixes);
      if (!page.isTruncated) {
        rootComplete = true;
        break;
      }
      rootContinuationToken = page.nextContinuationToken;
    } while (rootContinuationToken);

    interface ScopeState {
      prefix: string;
      continuationToken?: string;
      complete: boolean;
      requiredForCoverage: boolean;
    }
    const normalizedPriority = input.priorityPrefix?.replace(/^\/+/, "");
    const uniqueRoots = [...new Set(rootPrefixes)];
    const priorityRoot = normalizedPriority
      ? uniqueRoots.find((prefix) =>
          normalizedPriority.replace(/\/+$/, "") === prefix.replace(/\/+$/, "")
          || normalizedPriority.startsWith(prefix)
        )
      : undefined;
    const orderedRoots = uniqueRoots.sort((left, right) => {
      if (left === priorityRoot) return -1;
      if (right === priorityRoot) return 1;
      return left.localeCompare(right);
    });
    const hasRootObjects = [...objects.values()].some((object) => !object.key.includes("/"));
    discoveredFirstLevelPrefixes = orderedRoots.length + (hasRootObjects ? 1 : 0);
    prefixMode = discoveredFirstLevelPrefixes > FIRST_LEVEL_PREFIX_FULL_SCAN_THRESHOLD ? "top-n" : "all";

    if (prefixMode === "top-n") {
      const nestedPriority = normalizedPriority
        && normalizedPriority.replace(/\/+$/, "") !== priorityRoot?.replace(/\/+$/, "")
        ? normalizedPriority
        : undefined;
      const sampleScopes = nestedPriority ? [nestedPriority, ...orderedRoots] : orderedRoots;
      const remaining = Math.max(0, input.maxObjects - objects.size);
      const sampleSize = Math.max(1, Math.min(
        PREFIX_SAMPLE_MAX_OBJECTS,
        Math.floor(remaining / Math.max(1, sampleScopes.length)),
      ));
      for (const prefix of sampleScopes) {
        const page = await requestPage({ prefix, maxKeys: sampleSize });
        if (!page) break;
        addPage(page);
      }
    } else {
      const scopeGroups: ScopeState[][] = [];
      const fallbackScopes: ScopeState[] = [];
      for (const prefix of orderedRoots) {
        const page = await requestPage({ prefix, delimiter: "/" });
        if (!page) break;
        addPage(page);
        if (page.commonPrefixes.length) {
          scopeGroups.push(page.commonPrefixes.map((childPrefix) => ({
            prefix: childPrefix,
            complete: false,
            requiredForCoverage: !page.isTruncated,
          })));
        }
        if (page.isTruncated) {
          // 子目录发现也可能被分页截断，保留父 Prefix 游标作为完整覆盖的兜底。
          fallbackScopes.push({ prefix, complete: false, requiredForCoverage: true });
        }
      }
      const scopes: ScopeState[] = [];
      const widestGroup = Math.max(0, ...scopeGroups.map((group) => group.length));
      for (let index = 0; index < widestGroup; index += 1) {
        for (const group of scopeGroups) {
          const scope = group[index];
          if (scope) scopes.push(scope);
        }
      }
      scopes.push(...fallbackScopes);
      if (normalizedPriority && normalizedPriority.replace(/\/+$/, "") !== priorityRoot?.replace(/\/+$/, "")) {
        // 嵌套的 Service Prefix 单独获得游标，避免父 Prefix 部分扫描时跳过业务关注目录。
        scopes.unshift({
          prefix: normalizedPriority,
          complete: false,
          requiredForCoverage: false,
        });
      }

      while (!stoppedReason && scopes.some((scope) => !scope.complete)) {
        for (const scope of scopes) {
          if (scope.complete) continue;
          const page = await requestPage({
            prefix: scope.prefix,
            continuationToken: scope.continuationToken,
          });
          if (!page) break;
          addPage(page);
          scope.complete = !page.isTruncated;
          scope.continuationToken = page.nextContinuationToken;
        }
      }
      complete = rootComplete && scopes
        .filter((scope) => scope.requiredForCoverage)
        .every((scope) => scope.complete);
    }
  }

  if (!complete && !stoppedReason && prefixMode !== "top-n") {
    stoppedReason = objects.size >= input.maxObjects ? "object-limit" : "time-limit";
  }
  return summarizeS3Objects({
    objects: [...objects.values()],
    scopePrefix: input.prefix,
    now: input.now,
    complete,
    pages,
    stoppedReason,
    prefixMode,
    discoveredFirstLevelPrefixes,
  });
}
