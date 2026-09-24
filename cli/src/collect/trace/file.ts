import { chmodSync, copyFileSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { JaegerFileSource } from "@compforge/trace-harness";
import { CommandStatus, type CommandContext, type CommandResult } from "../../command";
import { DOCTOR_CLI_VERSION } from "../../app/version";
import { EvidenceBundle } from "../evidence";
import { exportTraceSnapshot, TRACE_FILES } from "./snapshot";
import { accumulateStats, newTraceStats } from "./probe";
import { buildTraceSummary } from "./render";
import type { TraceOutput } from "./index";

/** Import a complete local Jaeger trace into the same immutable evidence layout as online acquisition. */
export async function runFileTrace(file: string, context: CommandContext): Promise<CommandResult<TraceOutput>> {
  const path = resolve(file);
  const source = new JaegerFileSource(path, {
    format: extname(path).toLowerCase() === ".jsonl" ? "jsonl" : "jaeger",
  });
  const original = statSync(path);
  let traceId: string;
  let records: Record<string, unknown>[];
  try {
    const ids: string[] = [];
    for await (const id of source.select({ limit: 2 }, context.signal)) ids.push(id);
    if (!ids.length) throw new Error("本地 Jaeger 文件没有 trace");
    if (ids.length > 1) throw new Error("本地 Jaeger 文件包含多条 trace；请拆分文件后逐条导入");
    traceId = ids[0]!;
    const projected = await source.fetch(traceId, [], context.signal);
    const full = await source.read([...projected.values()].map(span => ({
      trace_id: traceId, span_id: span.span_id, index: span.storage_index, document_id: span.storage_id,
    })), null, context.signal);
    if (full.size !== projected.size) throw new Error("本地 Jaeger 文件缺少关联 raw span");
    records = [...full.values()].map(span => span.raw);
  } finally {
    await source.close();
  }

  const dir = mkdtempSync(join(tmpdir(), "doctor-trace-file-"));
  const artifact = context.artifacts.add({ command: "trace", path: dir });
  const bundle = new EvidenceBundle(dir);
  const originalName = extname(path).toLowerCase() === ".jsonl" ? "source.jsonl" : "source.json";
  copyFileSync(path, join(dir, originalName));
  chmodSync(join(dir, originalName), 0o600);
  const after = statSync(path);
  if (after.size !== original.size || after.mtimeMs !== original.mtimeMs || after.ino !== original.ino) {
    throw new Error("本地 Jaeger 文件在导入期间发生变化");
  }
  writeFileSync(join(dir, TRACE_FILES.spans), records.map(record => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
  const startedAt = new Date().toISOString();
  let projected = false;
  let reason: string | undefined;
  try {
    await exportTraceSnapshot(dir, traceId, { scope: "trace", complete: true });
    projected = true;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const status = projected ? CommandStatus.Ok : CommandStatus.Partial;
  bundle.addStep({ id: "file-import", title: "本地 Jaeger 文件导入", risk: "observe", status: "ok",
    output: `trace_id=${traceId} spans=${records.length} file=${basename(path)}` });
  bundle.addStep({ id: "analysis", title: "离线 tree / node 证据投影", risk: "observe",
    status: projected ? "ok" : "failed", reason });
  const stats = newTraceStats();
  accumulateStats(stats, records);
  bundle.writeSummary(buildTraceSummary({ traceId, inputId: traceId, resolvedAs: "trace_id",
    index: "local_file", channel: basename(path), count: records.length, downloaded: records.length, stats,
    steps: [`| file-import | ok | |`, `| analysis | ${projected ? "ok" : "failed"} | ${reason ?? ""} |`] }));
  bundle.writeCollection({
    doctorVersion: DOCTOR_CLI_VERSION,
    target: { trace_id: traceId, input_id: traceId, scope: "trace", resolved_as: "local_file" },
    files: { ...(projected ? TRACE_FILES : { spans: TRACE_FILES.spans }), source: originalName },
    inspectionFacts: {}, params: { input: "file", source_name: basename(path) },
    startedAt, finishedAt: new Date().toISOString(),
  });
  return { status, output: { items: [{ bizId: traceId, traceIds: [traceId], status, artifacts: [artifact], reason }] },
    artifacts: [artifact] };
}
