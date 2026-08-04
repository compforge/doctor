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

export function redisGroupedSampleSizes(totalKeys: number, targetSamples: number): number[] {
  const samples = Math.min(Math.max(0, totalKeys), Math.max(0, targetSamples));
  if (samples === 0) return [];
  const baseSize = Math.floor(totalKeys / samples);
  const largerGroups = totalKeys % samples;
  return Array.from({ length: samples }, (_, index) => baseSize + (index < largerGroups ? 1 : 0));
}

async function selectKeys(
  client: RedisConnectionApi,
  totalKeys: number,
  limit: number,
  scanCount: number,
): Promise<{ keys: string[]; visited: number }> {
  if (limit >= totalKeys) {
    if (totalKeys === 0) return { keys: [], visited: 0 };
    const uniqueKeys = new Set<string>();
    let cursor = "0";
    let visited = 0;
    do {
      const page = await client.scan(cursor, scanCount);
      cursor = page.cursor;
      visited += page.keys.length;
      for (const key of page.keys) uniqueKeys.add(key);
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
  } while (cursor !== "0");
  return { keys, visited };
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

/** redis-cli keyStats 的受预算实现：完整遍历 SCAN，并对均匀选中的 key 做 pipeline 检查。 */
export async function collectRedisKeyStats(
  client: RedisConnectionApi,
  options: RedisKeyStatsOptions,
): Promise<RedisKeyStatsResult> {
  const totalKeys = Math.max(0, Number(await client.dbSize()));
  const limit = Math.min(totalKeys, Math.max(0, options.maxKeys));
  const selected = await selectKeys(client, totalKeys, limit, options.scanCount);
  const result: RedisKeyStat[] = [];
  const startedAt = performance.now();
  for (let offset = 0; offset < selected.keys.length; offset += options.pipelineKeys) {
    const rows = await inspectKeys(
      client,
      selected.keys.slice(offset, offset + options.pipelineKeys),
      options.memorySamples,
    );
    result.push(...rows);
    const delay = result.length / options.maxKeysPerSecond * 1_000 - (performance.now() - startedAt);
    if (delay > 0) await sleep(delay);
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
