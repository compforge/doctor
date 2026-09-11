import type { CommandResult } from "../../command/result";
import { failureReport, type RenderContext } from "../../report/context";
import { evidencePage } from "../../report/evidence";
import type { Report, ReportPage } from "../../report/model";
import type { BundleManifest } from "../output/report/model";
import type { TraceOutput } from "./index";
import { renderTraceEvidence } from "./render";

export async function renderTraceReport(context: RenderContext, result: CommandResult<TraceOutput>): Promise<Report> {
  if (!result.output) return failureReport("doctor trace", result);
  const pages: ReportPage[] = [];
  for (const item of result.output.items) {
    const subject = { key: item.bizId, label: item.bizId };
    if (!item.artifacts.length) pages.push({ id: `trace:${item.bizId}`, title: "Trace", subject, status: item.status, reason: item.reason });
    for (const [index, artifact] of item.artifacts.entries()) pages.push(await evidencePage(context, artifact,
      { title: item.traceIds[index] ?? "Trace", subject, status: item.status, reason: item.reason }, async () => {
        const manifest = context.json<BundleManifest>(artifact, "manifest.json");
        const traceId = String(manifest.target?.trace_id ?? "");
        if (!traceId) throw new Error("Trace 证据缺少 trace_id");
        await renderTraceEvidence(artifact.path, traceId, result.output!.contributions);
        context.write(artifact, context.read(artifact, "trace.html"));
      }));
  }
  return { title: "doctor trace", sections: [{ id: "trace", title: "Trace", status: result.status, pages }] };
}
