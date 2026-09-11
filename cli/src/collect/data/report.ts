import type { CommandResult } from "../../command/result";
import { failureReport, type RenderContext } from "../../report/context";
import { evidencePage, writeEvidencePage } from "../../report/evidence";
import type { Report, ReportPage } from "../../report/model";
import type { DataOutput } from "./model";
import { buildDataHtml } from "./render";

export async function renderDataReport(context: RenderContext, result: CommandResult<DataOutput>): Promise<Report> {
  if (!result.output) return failureReport("doctor data", result);
  const pages: ReportPage[] = [];
  for (const item of result.output.items) {
    const subject = { key: item.bizId, label: item.bizId };
    if (!item.artifacts.length || !item.diagnosis) {
      pages.push({ id: `data:${item.bizId}`, title: "Data", subject, status: item.status, reason: item.reason ?? "未形成诊断结果" });
      continue;
    }
    for (const artifact of item.artifacts) pages.push(await evidencePage(context, artifact,
      { title: "Data", subject, status: item.status, reason: item.reason }, () => writeEvidencePage(context, artifact, {
        title: "doctor Data 业务数据汇集报告", summaryHtml: buildDataHtml(item.diagnosis!),
      })));
  }
  return { title: "doctor data", sections: [{ id: "data", title: "Data", status: result.status, pages }] };
}
