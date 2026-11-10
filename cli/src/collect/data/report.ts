import { dataListSummary } from "./list";
import { escapeHtml } from "../../report/escape";
import type { CommandResult } from "../../command/result";
import { failureReport, type RenderContext } from "../../report/context";
import { evidencePage, writeEvidencePage } from "../../report/evidence";
import type { Report, ReportPage } from "../../report/model";
import type { DataOutput } from "./model";
import { buildDataHtml } from "./render";

export async function renderDataReport(context: RenderContext, result: CommandResult<DataOutput>): Promise<Report> {
  if (!result.output) return failureReport("doctor data", result);
  const pages: ReportPage[] = [];
  for (const [index, item] of result.output.items.entries()) {
    const subject = { key: item.bizId, label: item.bizId };
    if (!item.artifacts.length || !item.diagnosis) {
      pages.push({ id: `data:${item.bizId}`, title: "Data", subject, status: item.status, reason: item.reason ?? "未形成诊断结果" });
      continue;
    }
    const file = result.output.items.length === 1 ? "report.html" : `data-${index + 1}.html`;
    for (const artifact of item.artifacts) pages.push(await evidencePage(context, artifact,
      { title: "Data", subject, status: item.status, reason: item.reason }, () => writeEvidencePage(context, artifact, {
        title: "doctor Data 业务数据汇集报告", summaryHtml: buildDataHtml(item.diagnosis!), inspectionFacts: { ...item.diagnosis!.evidence.facts },
      }, file), file));
  }
  if (result.output.typeResults?.length && result.artifacts[0]) {
    const artifact = result.artifacts[0];
    const file = result.output.items.length ? "data-types.html" : "report.html";
    pages.push(await evidencePage(context, artifact, { title: "业务类型查询", status: result.status }, () => writeEvidencePage(context, artifact, {
      title: "业务类型查询", summaryHtml: `<pre>${escapeHtml(dataListSummary(result.output!.typeResults!))}</pre>`,
      inspectionFacts: { typeResults: result.output!.typeResults },
    }, file), file));
  }
  return { title: "doctor data", sections: [{ id: "data", title: "Data", status: result.status, pages }] };
}
