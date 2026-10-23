import { escapeHtml } from "../output/report/components/content";
import { existsSync } from "node:fs";
import type { CommandResult } from "../../command/result";
import { failureReport, type RenderContext } from "../../report/context";
import { evidencePage } from "../../report/evidence";
import type { Report, ReportPage } from "../../report/model";
import type { CollectionRecord } from "../output/report/model";
import type { TraceOutput } from "./index";
import { aggregateCommandStatus } from "../../command/result";
import { dataSourceHealthStatus } from "../../datasource/health/status";
import { dataSourceHealthHtml, type DataSourceHealthEvidence } from "../../datasource/health/report";
import { renderTraceEvidence } from "./render";

export async function renderTraceReport(context: RenderContext, result: CommandResult<TraceOutput>): Promise<Report> {
  if (!result.output) return failureReport("doctor trace", result);
  const pages: ReportPage[] = [];
  const healthPages: ReportPage[] = [];
  for (const artifact of result.artifacts.filter(item => item.command === "datasource-health")) {
    const evidence = context.json<DataSourceHealthEvidence>(artifact, "health.json");
    healthPages.push(await evidencePage(context, artifact, { title: "OpenSearch 健康（附带信息）", status: dataSourceHealthStatus(evidence.health) }, () => {
      context.write(artifact, `<!doctype html><meta charset="utf-8"><title>OpenSearch 健康</title>${dataSourceHealthHtml(evidence)}`);
    }));
  }
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
          if (!existsSync(context.path(artifact, "analysis.json"))) {
            context.write(artifact, `<!doctype html><meta charset="utf-8"><title>Trace 采集结果</title><h1>${escapeHtml(traceId)}</h1><pre>${escapeHtml(context.read(artifact, "summary.md"))}</pre>`);
            return;
          }
          await renderTraceEvidence(context.artifact(artifact.id).path);
          context.write(artifact, context.read(artifact, "trace.html"));
        }));
    }
  }
  return { title: "doctor trace", sections: [{ id: "trace", title: "Trace", status: result.status, pages },
    ...(healthPages.length ? [{ id: "datasource-health", title: "数据源健康（附带信息）", status: aggregateCommandStatus(healthPages.map(page => page.status)), pages: healthPages }] : [])] };
}
