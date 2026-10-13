import type { View } from "@compforge/trace-harness";
import { existsSync } from "node:fs";
import { readTraceSnapshot } from "./snapshot";
import type { CommandResult } from "../../command/result";
import { failureReport, type RenderContext } from "../../report/context";
import { evidencePage } from "../../report/evidence";
import type { Report, ReportPage } from "../../report/model";
import type { CollectionRecord } from "../output/report/model";
import type { TraceOutput } from "./index";
import { renderTraceEvidence } from "./render";

export async function renderTraceReport(context: RenderContext, result: CommandResult<TraceOutput>): Promise<Report> {
  if (!result.output) return failureReport("doctor trace", result);
  const { render } = await import("@compforge/trace-harness");
  const pages: ReportPage[] = [];
  if (result.output.selection?.truncated) pages.push({
    id: "trace:selection", title: "时间范围选择已截断", status: result.status,
    subject: { key: "trace:selection", label: "时间范围选择" },
    reason: result.output.selection.truncated.reason,
  });
  for (const item of result.output.items) {
    const subject = { key: item.bizId, label: item.bizId };
    if (!item.artifacts.length) pages.push({ id: `trace:${item.bizId}`, title: "Trace", subject, status: item.status, reason: item.reason });
    for (const [index, artifact] of item.artifacts.entries()) {
      pages.push(await evidencePage(context, artifact,
        { title: item.artifactTraceIds?.[index] ?? item.traceIds[index] ?? "Trace", subject, status: item.status, reason: item.reason }, async () => {
          const manifest = context.json<CollectionRecord>(artifact, "collection.json");
          const traceId = String(manifest.target?.trace_id ?? "");
          if (!traceId) throw new Error("Trace 证据缺少 trace_id");
          await renderTraceEvidence(context.artifact(artifact.id).path);
          context.write(artifact, context.read(artifact, "trace.html"));
        }));
      if (pages.at(-1)?.renderError) continue;
      const dir = context.artifact(artifact.id).path;
      if (!existsSync(context.path(artifact, "analysis.json"))) continue;
      const snapshot = readTraceSnapshot(dir);
      const selected = existsSync(context.path(artifact, "view.json"))
        ? context.json<View>(artifact, "view.json") : snapshot.views.default;
      if (selected.scope === "trace" && selected.view === "default" && snapshot.views.agent) {
        pages.push(await evidencePage(context, artifact,
          { title: `${snapshot.trace_id} · Agent`, subject, status: item.status, reason: item.reason },
          () => { context.write(artifact, render(snapshot.views.agent!, { format: "html" }), "agent.html"); }, "agent.html"));
      }
    }
  }
  return { title: "doctor trace", sections: [{ id: "trace", title: "Trace", status: result.status, pages }] };
}
