import type { AgentRunIR, AnalysisContext, Findings, Measurements, NodeInit, NormSpan, TraceContributions, TraceHarness, TraceView, View, ViewRequest } from "@compforge/trace-harness";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TRACE_FILES = { spans: "spans.jsonl", tree: "tree.json", analysis: "analysis.json", findings: "findings.json" } as const;

export interface TraceCollection {
  scope: "trace" | "span";
  /** Completeness of this query, not a claim that a single-span query captured the entire trace. */
  complete: boolean;
  span_id?: string;
}

type SavedSpan = Pick<NormSpan, "span_id" | "parent_span_id" | "name" | "start_ms" | "dur_ms" | "service"
  | "has_error" | "attrs" | "error_events" | "events" | "loaded_fields" | "field_errors">;

/** Frozen projection, not executable Plugin code. Node identity survives Plugin upgrades and offline delivery. */
export interface TraceSnapshot {
  schema_version: 2;
  kind: "doctor.trace";
  trace_id: string;
  collection: TraceCollection;
  nodes: NodeInit[];
  spans: SavedSpan[];
  measurements: Pick<Measurements, "specs" | "sources" | "nodes" | "trace">;
  agent_runs?: AgentRunIR;
  views: { default: TraceView; agent?: TraceView };
}

export function writeTraceJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Materialize while the lease is alive; persist values, never temporary harness paths. */
async function withTraceAnalysis(dir: string, traceId: string, contributions: TraceContributions | undefined,
  completeTrace: boolean, consume: (analysis: AnalysisContext, harness: TraceHarness) => void): Promise<void> {
  const { genAiSpecs, JaegerFileSource, TraceHarness } = await import("@compforge/trace-harness");
  const harness = new TraceHarness(contributions ?? { specs: genAiSpecs() });
  const session = harness.open(new JaegerFileSource(join(dir, TRACE_FILES.spans)), { config: { activeTraces: 1 } });
  try {
    const dataset = await session.select({ trace_ids: [traceId], limit: 1 });
    const lease = await session.tree(dataset, traceId);
    try {
      // Absence-based diagnosis and trace-wide measurements are invalid for a single span / partial download.
      const analysis = await session.analyze(lease.analysis, completeTrace ? {} : { diagnosis: false, metrics: [] });
      await session.prepareView(analysis, { full: true });
      consume(analysis, harness);
    } finally { await lease.close(); }
  } finally { await session.close(); }
}

export async function exportTraceSnapshot(dir: string, traceId: string, collection: TraceCollection,
  contributions?: TraceContributions): Promise<void> {
  await withTraceAnalysis(dir, traceId, contributions, collection.scope === "trace" && collection.complete, (analysis, harness) => {
    const trace = analysis.trace;
    const visible = harness.visibleMeasurements(trace, analysis.measurements);
    // Prepare only report-selected anchors; explicit offline node queries prepare other anchors on demand.
    harness.prepare(analysis, { agentRuns: true, callBreakdowns: Object.keys(visible.nodes).filter(id =>
      visible.nodes[id]?.some(m => m.kind === "calls_until_node_end")) });
    const snapshot: TraceSnapshot = {
      schema_version: 2, kind: "doctor.trace", trace_id: traceId, collection,
      nodes: trace.nodes,
      // Raw records remain in spans.jsonl. Normalized values preserve Plugin normalization for offline views.
      spans: [...trace.spans.values()].map(span => ({
        span_id: span.span_id, parent_span_id: span.parent_span_id, name: span.name,
        start_ms: span.start_ms, dur_ms: span.dur_ms, service: span.service, has_error: span.has_error,
        attrs: span.attrs, error_events: span.error_events, events: span.events,
        loaded_fields: span.loaded_fields, field_errors: span.field_errors,
      })),
      measurements: analysis.measurements,
      agent_runs: analysis.agentRuns,
      views: {
        default: harness.buildView(analysis, { scope: "trace" }) as TraceView,
        ...(analysis.agentRuns ? { agent: harness.buildView(analysis, { scope: "trace", view: "agent" }) as TraceView } : {}),
      },
    };
    writeTraceJson(dir, TRACE_FILES.analysis, snapshot);
    writeTraceJson(dir, TRACE_FILES.findings, analysis.findings);
    writeTraceJson(dir, TRACE_FILES.tree, {
      schema_version: 1, kind: "doctor.trace.tree", trace_id: traceId, collection,
      roots: trace.tree().roots.map(node => node.node_id),
      nodes: trace.nodes.map(node => ({
        node_id: node.node_id, parent_node_id: node.parent_node_id, kind: node.kind, name: node.name, value: node.value,
        service: node.service, start_ms: node.start_ms, duration_ms: node.duration_ms,
        primary_span_id: node.primary_span_id, span_ids: node.span_ids, error_span_ids: node.error_span_ids,
      })),
    });
  });
}

export function readTraceSnapshot(dir: string): TraceSnapshot {
  const snapshot = JSON.parse(readFileSync(join(dir, TRACE_FILES.analysis), "utf8")) as TraceSnapshot;
  if (snapshot.kind !== "doctor.trace" || snapshot.schema_version !== 2 || !snapshot.trace_id
    || !snapshot.views?.default || !snapshot.measurements?.nodes || !Array.isArray(snapshot.measurements?.trace)
    || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.spans) || !snapshot.collection
    || !["trace", "span"].includes(snapshot.collection.scope) || typeof snapshot.collection.complete !== "boolean") {
    throw new Error("不支持的 trace 证据版本或结构；需要 schema_version=2 的 analysis.json，可用 --trace-file 重新导入原始 spans");
  }
  return snapshot;
}

/** Rehydrate frozen facts; no Source, extractor or Detector runs during offline selection. */
async function snapshotAnalysis(dir: string, snapshot: TraceSnapshot): Promise<AnalysisContext> {
  const { Node, NormSpan, TraceContext, Measurements, AnalysisContext } = await import("@compforge/trace-harness");
  const findings = JSON.parse(readFileSync(join(dir, TRACE_FILES.findings), "utf8")) as Findings;
  const spans = snapshot.spans.map(value => {
    const span = new NormSpan(value.span_id, value.parent_span_id, value.name, value.start_ms, value.dur_ms,
      value.service, value.has_error, value.attrs, {}, value.error_events, value.events);
    span.loaded_fields = value.loaded_fields;
    span.field_errors = value.field_errors;
    return [span.span_id, span] as const;
  });
  const trace = new TraceContext(snapshot.trace_id, new Map(spans), snapshot.nodes.map(node => new Node(node)), new Map());
  const m = snapshot.measurements;
  const analysis = new AnalysisContext(trace, new Measurements(m.specs, m.sources, m.nodes, m.trace), findings);
  analysis.agentRuns = snapshot.agent_runs;
  return analysis;
}

export type TraceViewOptions = { node?: string; view?: "default" | "agent" | "measurements" | "timeline" };

/** @spec Prepare derivatives explicitly from saved evidence, then select a View; never reacquire data. */
export async function selectTraceView(dir: string, options: TraceViewOptions = {}): Promise<View> {
  const { TraceHarness, buildView } = await import("@compforge/trace-harness");
  const snapshot = readTraceSnapshot(dir);
  if (!options.node && (options.view === undefined || options.view === "default")) return snapshot.views.default;
  if (!options.node && options.view === "agent" && snapshot.views.agent) return snapshot.views.agent;
  const analysis = await snapshotAnalysis(dir, snapshot);
  if (snapshot.collection.scope === "trace" && snapshot.collection.complete
    && options.node && ["measurements", "timeline"].includes(options.view ?? "")) {
    new TraceHarness({}).prepare(analysis, { callBreakdowns: [options.node] });
  }
  const request = options.node
    ? { scope: "node", nodeId: options.node, view: options.view ?? "default" }
    : { scope: "trace", view: options.view ?? "default" };
  return buildView(analysis, request as ViewRequest);
}

/** @spec One trace is one report result; its prepared views switch inside the same HTML page. */
export async function renderTraceSnapshot(dir: string): Promise<void> {
  const { render } = await import("@compforge/trace-harness");
  const { existsSync } = await import("node:fs");
  const snapshot = readTraceSnapshot(dir);
  const view: View = existsSync(join(dir, "view.json"))
    ? JSON.parse(readFileSync(join(dir, "view.json"), "utf8")) : snapshot.views.default;
  const html = view.scope === "trace"
    ? render([view, ...Object.values(snapshot.views).filter(other => other.view !== view.view)], { format: "html" })
    : render(view, { format: "html" });
  writeFileSync(join(dir, "trace.html"), html, { mode: 0o600 });
}
