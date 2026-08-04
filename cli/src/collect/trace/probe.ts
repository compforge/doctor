import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { SearchEngine } from "../../infra/search";
import type { EvidenceBundle } from "../evidence";
import { countSpans, downloadSpans, resolveTraceId, type ResolvedTrace } from "./opensearch";

export interface TraceStats {
  total: number;
  services: Record<string, number>;
  errorSpans: number;
  minStartMs?: number;
  maxEndMs?: number;
}

export function newTraceStats(): TraceStats {
  return { total: 0, services: {}, errorSpans: 0 };
}

/** 按页累计统计（jaeger span _source 字段：process.serviceName / startTimeMillis / duration(µs) / tags）。 */
export function accumulateStats(stats: TraceStats, sources: Array<Record<string, any>>): void {
  for (const source of sources) {
    stats.total += 1;
    const service = source?.process?.serviceName ?? "(unknown)";
    stats.services[service] = (stats.services[service] ?? 0) + 1;
    const start = Number(source?.startTimeMillis);
    if (Number.isFinite(start)) {
      stats.minStartMs = stats.minStartMs === undefined ? start : Math.min(stats.minStartMs, start);
      const end = start + (Number.isFinite(Number(source?.duration)) ? Number(source.duration) / 1000 : 0);
      stats.maxEndMs = stats.maxEndMs === undefined ? end : Math.max(stats.maxEndMs, end);
    }
    const tags = Array.isArray(source?.tags) ? source.tags : [];
    const isError = tags.some(
      (tag: Record<string, unknown>) =>
        (tag?.key === "error" && (tag?.value === true || tag?.value === "true")) ||
        (tag?.key === "otel.status_code" && tag?.value === "ERROR"),
    );
    if (isError) stats.errorSpans += 1;
  }
}

export interface TraceProbeOptions {
  inputId: string;
  index: string;
  pageSize: number;
  outputDir: string;
}

export type TraceProbeResult =
  | {
      ok: true;
      traceId: string;
      resolved: ResolvedTrace;
      count: number;
      downloaded: number;
      complete: boolean;
      stats: TraceStats;
    }
  | {
      ok: false;
      title: string;
      reason: string;
      traceId?: string;
    };

/** 执行确定性的 trace 查询与全量下载；访问通道已由 preparation 准备完成。 */
export async function probeTrace(
  search: SearchEngine,
  opts: TraceProbeOptions,
  bundle: EvidenceBundle,
  log: (line: string) => void,
): Promise<TraceProbeResult> {
  log(`[collect] 解析 id（index=${opts.index}）…`);
  let resolved: ResolvedTrace | undefined;
  try {
    resolved = await resolveTraceId(search, opts.index, opts.inputId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    bundle.fill("resolve-id", { status: "failed", reason });
    log(`[collect] id 解析失败：${reason}`);
    return { ok: false, title: "id 解析失败", reason };
  }
  if (!resolved) {
    const reason = `index '${opts.index}' 中既没有 traceID=${opts.inputId}，span tag 值反查也未命中（id 有误 / 已过保留期 / index 或环境不对）`;
    bundle.fill("resolve-id", { status: "failed", reason });
    log(`[collect] ${reason}`);
    return { ok: false, title: "id 未解析到 trace", reason: `${reason}；确认 id、--index-date 与目标环境` };
  }

  const traceId = resolved.traceId;
  bundle.fill("resolve-id", {
    status: "ok",
    output: JSON.stringify({
      input_id: opts.inputId,
      resolved_as: resolved.resolvedAs,
      trace_id: traceId,
      candidates: resolved.candidates,
    }),
    ext: "json",
  });
  if (resolved.resolvedAs === "tag") {
    const extra = (resolved.candidates?.length ?? 0) > 1
      ? `；另有 ${resolved.candidates!.length - 1} 个候选 trace（取最近活跃，全部见 raw/resolve-id）`
      : "";
    log(`[collect] id 经 span tag 反查解析为 trace_id=${traceId}${extra}`);
  }

  log(`[collect] 查询 span 总数（trace_id=${traceId}）…`);
  let count: number;
  try {
    count = await countSpans(search, opts.index, traceId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    bundle.fill("count", { status: "failed", reason });
    log(`[collect] count 失败：${reason}`);
    return { ok: false, title: "span 总数查询失败", reason, traceId };
  }
  bundle.fill("count", { status: "ok", output: String(count) });
  if (count === 0) {
    const reason = `index '${opts.index}' 中没有该 trace 的 span；确认 --index-date 与目标环境`;
    log(`[collect] index '${opts.index}' 中没有 trace_id=${traceId} 的 span（已过保留期 / index 或环境不对）`);
    return { ok: false, title: "span 总数为 0", reason, traceId };
  }

  log(`[collect] 下载 ${count} 个 span…`);
  const spansPath = join(opts.outputDir, "spans.jsonl");
  const stats = newTraceStats();
  let downloaded: number;
  try {
    downloaded = await downloadSpans(search, opts.index, traceId, opts.pageSize, (sources) => {
      appendFileSync(spansPath, `${sources.map((source) => JSON.stringify(source)).join("\n")}\n`, "utf-8");
      accumulateStats(stats, sources);
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    bundle.fill("download", { status: "failed", reason });
    log(`[collect] 下载失败：${reason}（已下载 ${stats.total} 条保留在 spans.jsonl）`);
    return {
      ok: false,
      title: "span 下载中断",
      reason: `${reason}；spans.jsonl 保留已下载的 ${stats.total} 条`,
      traceId,
    };
  }

  const complete = downloaded === count;
  bundle.fill("download", {
    status: complete ? "ok" : "failed",
    reason: complete ? undefined : `下载条数 ${downloaded} != count ${count}（下载期间索引可能有写入/滚动）`,
    output: `count=${count} downloaded=${downloaded}`,
  });
  return { ok: true, traceId, resolved, count, downloaded, complete, stats };
}
