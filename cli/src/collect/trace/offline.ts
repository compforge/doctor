import { cpSync, createReadStream, lstatSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { aggregateCommandStatus, CommandStatus, type CommandContext, type CommandResult } from "../../command";
import type { StepRecord } from "../evidence";
import type { TraceOutput } from "./index";
import { readTraceSnapshot, TRACE_FILES, writeTraceJson, type TraceSnapshot } from "./snapshot";
import { decodeSpanPayloads } from "./decode";

interface TraceManifest {
  source?: unknown;
  kind?: string;
  schema_version?: number;
  status?: CommandStatus;
  target?: Record<string, unknown>;
  files?: Record<string, string | { path: string }>;
  children?: { manifest: string }[];
  steps?: StepRecord[];
}

interface LocalTrace {
  manifestPath: string;
  manifest: TraceManifest;
  snapshot?: TraceSnapshot;
}

function readManifest(path: string): TraceManifest {
  return JSON.parse(readFileSync(path, "utf8")) as TraceManifest;
}

/** Resolve --from to a manifest path: a directory is completed to <dir>/manifest.json. */
function resolveManifestPath(from: string): string {
  const resolved = resolve(from);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    throw new Error(`--from 路径不存在：${resolved}`);
  }
  if (!stat.isDirectory()) return resolved;
  const candidate = join(resolved, "manifest.json");
  try {
    if (lstatSync(candidate).isFile()) return candidate;
  } catch { /* fall through to the friendly error below */ }
  throw new Error(
    `--from 指向目录但未找到 ${candidate}；请传 bundle 目录（含 manifest.json）或 manifest.json 的完整路径`,
  );
}

/** Portable bundles resolve relative to their actual location, never a stale bundle_root in JSON. */
function containedPath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`证据路径必须是相对路径：${path}`);
  const candidate = resolve(root, path);
  const inside = (value: string) => value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
  if (!inside(relative(root, candidate)) || !inside(relative(realpathSync(root), realpathSync(candidate)))) {
    throw new Error(`证据路径越界：${path}`);
  }
  return candidate;
}

function localTraces(from: string): { traces: LocalTrace[]; sourceStatus?: CommandStatus; source?: unknown } {
  const path = realpathSync(resolveManifestPath(from));
  const root = dirname(path);
  const source = readManifest(path);
  const paths: string[] = [];
  const visited = new Set<string>();
  const visit = (manifestPath: string) => {
    if (visited.has(manifestPath)) return;
    visited.add(manifestPath);
    const manifest = readManifest(manifestPath);
    if (manifest.target?.trace_id) { paths.push(manifestPath); return; }
    const references = [
      ...(manifest.children ?? []).map(child => child.manifest),
      ...Object.values(manifest.files ?? {}).map(file => typeof file === "string" ? file : file.path)
        .filter(file => file.endsWith("/manifest.json")),
    ];
    for (const ref of references) {
      if (isAbsolute(ref)) throw new Error(`证据路径必须是相对路径：${ref}`);
      visit(containedPath(root, relative(root, resolve(dirname(manifestPath), ref))));
    }
  };
  visit(path);
  const traces = paths.flatMap(manifestPath => {
    const manifest = readManifest(manifestPath);
    if (!manifest.target?.trace_id) return [];
    const dir = dirname(manifestPath);
    // Validate referenced files before reading. Copying below also rejects any unreferenced symlinks.
    for (const file of Object.values(manifest.files ?? {})) containedPath(dir, typeof file === "string" ? file : file.path);
    if (manifest.files?.analysis) for (const [key, path] of Object.entries(TRACE_FILES)) {
      if ((typeof manifest.files[key] === "string" ? manifest.files[key] : manifest.files[key]?.path) !== path) throw new Error(`不支持的 trace 证据布局：${key}`);
      containedPath(dir, path);
    }
    const snapshot = manifest.files?.analysis
      ? readTraceSnapshot(dir) : undefined;
    if (snapshot && snapshot.trace_id !== manifest.target.trace_id) throw new Error("manifest 与 analysis 的 trace_id 不一致");
    return [{ manifestPath, manifest, snapshot }];
  });
  if (!traces.length) throw new Error("manifest 没有 trace 证据；请使用 doctor trace --format manifest 的输出");
  return { traces, sourceStatus: source.status, source: source.source };
}

async function selection(trace: LocalTrace, input: { span?: string; node?: string }): Promise<unknown> {
  const snapshot = trace.snapshot!;
  const node = input.node ? snapshot.nodes.find(node => node.node_id === input.node)! : undefined;
  const ids = new Set(node ? node.span_ids : [input.span!]);
  const records = new Map<string, Record<string, unknown>>();
  const dir = dirname(trace.manifestPath);
  const lines = createInterface({ input: createReadStream(containedPath(dir, TRACE_FILES.spans)), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const span = JSON.parse(line) as Record<string, unknown>;
      if (span.traceID === snapshot.trace_id && typeof span.spanID === "string" && ids.has(span.spanID)) records.set(span.spanID, span);
    }
  } finally { lines.close(); }
  const missing = [...ids].filter(id => !records.has(id));
  if (missing.length) throw new Error(`本地证据缺少关联 span：${missing.join(", ")}；不会回连 OpenSearch`);
  const findings = JSON.parse(readFileSync(containedPath(dir, TRACE_FILES.findings), "utf8")) as Record<string, unknown>;
  return {
    schema_version: 1, kind: "doctor.trace.selection", trace_id: snapshot.trace_id,
    collection: snapshot.collection, node_id: input.node, span_id: input.span, node,
    findings: node ? findings[node.node_id] ?? [] : undefined,
    // Decode [trace zstd …] offload markers in the raw span so the caller sees the
    // original tool/model payload, not the compressed marker. ref/omitted markers pass
    // through (ref targets live in other spans of the same run; omitted is lossy).
    spans: [...ids].map(id => ({ ...snapshot.spans.find(span => span.span_id === id), raw: records.has(id) ? decodeSpanPayloads(records.get(id)!) : records.get(id) })),
  };
}

/** Offline invocation owns a fresh copy. Rendering/delivery must never mutate or clean up the input bundle. */
export async function runOfflineTrace(input: { from: string; node?: string; span?: string },
  context: CommandContext): Promise<CommandResult<TraceOutput>> {
  const source = localTraces(input.from);
  let traces = source.traces;
  if (input.node || input.span) {
    traces = traces.filter(trace => input.node
      ? trace.snapshot?.nodes.some(node => node.node_id === input.node)
      : trace.snapshot?.spans.some(span => span.span_id === input.span));
    if (!traces.length) throw new Error("本地证据未包含指定 node/span（可能未采集或已截断）；不会回连 OpenSearch");
    if (traces.length > 1) throw new Error("node/span 在多个 trace 证据中存在歧义；请用该 trace 的 artifact manifest 路径");
  }
  const items: TraceOutput["items"][number][] = [];
  for (const trace of traces) {
    context.signal.throwIfAborted();
    const detail = input.node || input.span ? await selection(trace, input) : undefined;
    const dir = mkdtempSync(join(tmpdir(), "doctor-trace-offline-"));
    const artifact = context.artifacts.add({ command: "trace", path: dir });
    cpSync(dirname(trace.manifestPath), dir, { recursive: true, filter: path => {
      if (lstatSync(path).isSymbolicLink()) throw new Error("离线证据不能包含符号链接");
      return true;
    } });
    const manifest = { ...trace.manifest,
      source: { manifest: trace.manifestPath, mode: "offline", upstream: trace.manifest.source ?? source.source,
        status: source.sourceStatus },
      target: { ...trace.manifest.target, ...(detail ? { selected_node_id: input.node, selected_span_id: input.span } : {}) },
      files: { ...trace.manifest.files, ...(detail ? { selection: "selection.json" } : {}) },
    };
    if (detail) writeTraceJson(dir, "selection.json", detail);
    writeTraceJson(dir, "manifest.json", manifest);
    const incomplete = !trace.snapshot?.collection.complete
      || trace.manifest.steps?.some(step => !["ok", "unnecessary"].includes(step.status) || step.truncation);
    const status = !trace.snapshot ? CommandStatus.Failed : incomplete ? CommandStatus.Partial : CommandStatus.Ok;
    items.push({ bizId: String(trace.manifest.target!.input_id ?? trace.snapshot?.trace_id ?? "trace"),
      traceIds: [String(trace.manifest.target!.trace_id)], status, artifacts: [artifact],
      reason: !trace.snapshot ? "本地证据没有 analysis.json；原始证据保留，无法下钻 node" : incomplete ? "源证据不完整；离线操作未补采" : undefined });
  }
  const statuses = items.map(item => item.status);
  if (source.sourceStatus && source.sourceStatus !== CommandStatus.Ok) statuses.push(source.sourceStatus);
  return { status: aggregateCommandStatus(statuses), output: { items }, artifacts: items.flatMap(item => item.artifacts) };
}
