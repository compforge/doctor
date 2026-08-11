import type { RedisConnectionApi } from "./client";

export interface RedisKeyStat {
  key: string;
  type: string;
  memoryBytes: number;
  ttlMs: number;
  length: number | null;
}

export interface RedisKeyStatsOptions {
  maxKeys: number;
  maxKeysPerSecond: number;
  scanCount: number;
  pipelineKeys: number;
  memorySamples: number;
  onSelectionProgress?: (selected: number, limit: number) => void;
  onProgress?: (inspected: number, limit: number) => void;
}

export interface RedisKeyStatsResult {
  totalKeys: number;
  visitedKeys: number;
  inspectedKeys: number;
  scanComplete: boolean;
  keys: RedisKeyStat[];
}

const LENGTH_COMMANDS: Record<string, string> = {
  string: "STRLEN",
  list: "LLEN",
  set: "SCARD",
  hash: "HLEN",
  zset: "ZCARD",
  stream: "XLEN",
};

const RANDOM_SAMPLE_MAX_FRACTION = 0.1;
const RANDOM_SAMPLE_DRAW_MULTIPLIER = 1.25;

function text(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
}

function integer(value: unknown, fallback: number): number {
  if (value instanceof Error || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle(startedAt: number, processed: number, maxPerSecond: number): Promise<void> {
  const delay = processed / maxPerSecond * 1_000 - (performance.now() - startedAt);
  if (delay > 0) await sleep(delay);
}

export function redisGroupedSampleSizes(totalKeys: number, targetSamples: number): number[] {
  const samples = Math.min(Math.max(0, totalKeys), Math.max(0, targetSamples));
  if (samples === 0) return [];
  const baseSize = Math.floor(totalKeys / samples);
  const largerGroups = totalKeys % samples;
  return Array.from({ length: samples }, (_, index) => baseSize + (index < largerGroups ? 1 : 0));
}

async function selectKeysByScan(
  client: RedisConnectionApi,
  totalKeys: number,
  limit: number,
  scanCount: number,
  maxKeysPerSecond: number,
  onProgress?: (selected: number, limit: number) => void,
): Promise<{ keys: string[]; visited: number }> {
  const startedAt = performance.now();
  if (limit >= totalKeys) {
    const uniqueKeys = new Set<string>();
    let cursor = "0";
    let visited = 0;
    do {
      const page = await client.scan(cursor, scanCount);
      cursor = page.cursor;
      visited += page.keys.length;
      for (const key of page.keys) uniqueKeys.add(key);
      onProgress?.(uniqueKeys.size, limit);
      await throttle(startedAt, visited, maxKeysPerSecond);
    } while (cursor !== "0");
    return { keys: [...uniqueKeys], visited };
  }
  const groupSizes = redisGroupedSampleSizes(totalKeys, limit);
  const keys: string[] = [];
  let groupIndex = 0;
  let groupPosition = 0;
  let selectedPosition = groupSizes.length ? Math.floor(Math.random() * groupSizes[0]!) : -1;
  let cursor = "0";
  let visited = 0;
  do {
    const page = await client.scan(cursor, scanCount);
    cursor = page.cursor;
    for (const key of page.keys) {
      visited += 1;
      if (groupIndex >= groupSizes.length) continue;
      if (groupPosition === selectedPosition) keys.push(key);
      groupPosition += 1;
      if (groupPosition >= groupSizes[groupIndex]!) {
        groupIndex += 1;
        groupPosition = 0;
        selectedPosition = groupIndex < groupSizes.length
          ? Math.floor(Math.random() * groupSizes[groupIndex]!)
          : -1;
      }
    }
    onProgress?.(keys.length, limit);
    await throttle(startedAt, visited, maxKeysPerSecond);
  } while (cursor !== "0");
  return { keys, visited };
}

async function selectKeysByRandomDraw(
  client: RedisConnectionApi,
  limit: number,
  pipelineKeys: number,
  maxKeysPerSecond: number,
  onProgress?: (selected: number, limit: number) => void,
): Promise<{ keys: string[]; visited: number }> {
  const keys = new Set<string>();
  const maxDraws = Math.ceil(limit * RANDOM_SAMPLE_DRAW_MULTIPLIER);
  const startedAt = performance.now();
  let visited = 0;
  while (keys.size < limit && visited < maxDraws) {
    const batchSize = Math.min(pipelineKeys, maxDraws - visited);
    const replies = await client.pipeline(Array.from({ length: batchSize }, () => ["RANDOMKEY"]));
    visited += batchSize;
    for (const reply of replies) {
      if (!(reply instanceof Error) && reply !== null && reply !== undefined) keys.add(text(reply));
      if (keys.size >= limit) break;
    }
    onProgress?.(keys.size, limit);
    await throttle(startedAt, visited, maxKeysPerSecond);
  }
  return { keys: [...keys].slice(0, limit), visited };
}

async function selectKeys(
  client: RedisConnectionApi,
  totalKeys: number,
  limit: number,
  options: RedisKeyStatsOptions,
): Promise<{ keys: string[]; visited: number }> {
  if (limit === 0) return { keys: [], visited: 0 };
  // 抽样占比低时避免完整遍历大 keyspace；占比较高时 SCAN 更少重复，也能完成全量检查。
  if (limit / totalKeys < RANDOM_SAMPLE_MAX_FRACTION) {
    return selectKeysByRandomDraw(
      client,
      limit,
      options.pipelineKeys,
      options.maxKeysPerSecond,
      options.onSelectionProgress,
    );
  }
  return selectKeysByScan(
    client,
    totalKeys,
    limit,
    options.scanCount,
    options.maxKeysPerSecond,
    options.onSelectionProgress,
  );
}

async function inspectKeys(
  client: RedisConnectionApi,
  keys: string[],
  memorySamples: number,
): Promise<RedisKeyStat[]> {
  const typeReplies = await client.pipeline(keys.map((key) => ["TYPE", key]));
  const types = typeReplies.map((value) => value instanceof Error ? "unknown" : text(value));
  const commands: string[][] = [];
  const replyOffsets: Array<{ ttl: number; memory: number; length?: number }> = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const type = types[index]!;
    const ttl = commands.push(["PTTL", key]) - 1;
    const memory = commands.push(["MEMORY", "USAGE", key, "SAMPLES", String(memorySamples)]) - 1;
    const lengthCommand = LENGTH_COMMANDS[type];
    const length = lengthCommand ? commands.push([lengthCommand, key]) - 1 : undefined;
    replyOffsets.push({ ttl, memory, length });
  }
  const replies = commands.length ? await client.pipeline(commands) : [];
  return keys.map((key, index) => {
    const offsets = replyOffsets[index]!;
    return {
      key,
      type: types[index]!,
      ttlMs: integer(replies[offsets.ttl], -3),
      memoryBytes: integer(replies[offsets.memory], 0),
      length: offsets.length === undefined ? null : integer(replies[offsets.length], 0),
    };
  });
}

/** redis-cli keyStats 的受预算实现：有界选择 key，并用 pipeline 检查元数据。 */
export async function collectRedisKeyStats(
  client: RedisConnectionApi,
  options: RedisKeyStatsOptions,
): Promise<RedisKeyStatsResult> {
  const totalKeys = Math.max(0, Number(await client.dbSize()));
  const limit = Math.min(totalKeys, Math.max(0, options.maxKeys));
  const selected = await selectKeys(client, totalKeys, limit, options);
  const result: RedisKeyStat[] = [];
  const startedAt = performance.now();
  for (let offset = 0; offset < selected.keys.length; offset += options.pipelineKeys) {
    const rows = await inspectKeys(
      client,
      selected.keys.slice(offset, offset + options.pipelineKeys),
      options.memorySamples,
    );
    result.push(...rows);
    await throttle(startedAt, result.length, options.maxKeysPerSecond);
    options.onProgress?.(result.length, limit);
  }
  return {
    totalKeys,
    visitedKeys: selected.visited,
    inspectedKeys: result.length,
    scanComplete: limit >= totalKeys,
    keys: result,
  };
}
