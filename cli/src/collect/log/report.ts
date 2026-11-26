import { existsSync } from "node:fs";
import { join } from "node:path";
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
    const subject = { key: item.bizId ?? "service-logs", label: item.bizId ?? "Service 日志" };
    if (!item.artifacts.length) pages.push({ id: `log:${subject.key}`, title: "Log", subject, status: item.status, reason: item.reason });
    for (const artifact of item.artifacts) {
      const dir = context.artifact(artifact.id).path;
      const evidenceDir = context.bundleDirectory(artifact);
      const page = await evidencePage(context, artifact, { title: "Log", subject, status: item.status, reason: item.reason },
        () => writeLogHtmlReport(dir, context.path(artifact, "report.html"), context.profileName, evidenceDir, item.reason));
      if (page.renderError) {
        const files = ["timeline.jsonl", "service-logs.txt", "error.log"].filter(file => existsSync(join(dir, file)));
        const details = [item.reason, page.renderError, ...files.map(file => join(evidenceDir, file))].filter(Boolean);
        pages.push({ ...page, renderError: details.join("\n") });
      } else {
        pages.push(page);
      }
    }
  }
  return { title: "doctor log", sections: [{ id: "log", title: "Log", status: result.status, pages }] };
}
