import type { CommandResult } from "../../command/result";
import { failureReport, type RenderContext } from "../../report/context";
import { evidencePage } from "../../report/evidence";
import type { Report, ReportPage } from "../../report/model";
import { writeLogHtmlReport } from "./html";
import type { LogOutput } from "./index";

export async function renderLogReport(context: RenderContext, result: CommandResult<LogOutput>): Promise<Report> {
  if (!result.output) return failureReport("doctor log", result);
  const pages: ReportPage[] = [];
  for (const item of result.output.items) {
    const subject = { key: item.bizId, label: item.bizId };
    if (!item.artifacts.length) pages.push({ id: `log:${item.bizId}`, title: "Log", subject, status: item.status, reason: item.reason });
    for (const artifact of item.artifacts) pages.push(await evidencePage(context, artifact,
      { title: "Log", subject, status: item.status, reason: item.reason }, () =>
        writeLogHtmlReport(artifact.path, context.path(artifact, "report.html"), context.profileName)));
  }
  return { title: "doctor log", sections: [{ id: "log", title: "Log", status: result.status, pages }] };
}
