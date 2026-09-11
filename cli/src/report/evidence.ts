import type { BundleManifest, HtmlReportOptions } from "../collect/output/report/model";
import { buildHtmlReport } from "../collect/output/report/shell";
import type { CommandArtifact } from "../command/artifacts";
import type { CommandResult } from "../command/result";
import { CommandStatus } from "../command/status";
import { failureReport, type RenderContext } from "./context";
import type { Report, ReportPage, ReportSubject } from "./model";

export function writeEvidencePage(context: RenderContext, artifact: CommandArtifact, options: Omit<HtmlReportOptions, "profileName">): void {
  context.write(artifact, buildHtmlReport(context.json<BundleManifest>(artifact, "manifest.json"), {
    ...options, profileName: context.profileName,
  }));
}

export async function evidencePage(context: RenderContext, artifact: CommandArtifact,
  input: { title: string; status: CommandStatus; subject?: ReportSubject; reason?: string },
  render: () => void | Promise<void>): Promise<ReportPage> {
  try { await context.materialize(artifact, render); return context.page(artifact, input); }
  catch (error) {
    context.failed(input.title, error);
    return { id: `${artifact.id}:report.html`, title: input.title, subject: input.subject, status: input.status, reason: input.reason,
      renderError: error instanceof Error ? error.message : String(error) };
  }
}

export async function renderEvidence(context: RenderContext, result: CommandResult<unknown>, options: {
  command: string; title: string; scope?: string;
  render: (artifact: CommandArtifact) => void | Promise<void>;
}): Promise<Report> {
  const artifacts = result.artifacts.filter(artifact => artifact.command === options.command);
  if (!artifacts.length) return failureReport(`doctor ${options.command}`, result);
  const pages: ReportPage[] = [];
  for (const artifact of artifacts) pages.push(await evidencePage(context, artifact,
    { title: options.title, status: result.status }, () => options.render(artifact)));
  return { title: `doctor ${options.command}`, sections: [{ id: options.command, title: options.title,
    status: result.status, scope: options.scope, pages }] };
}
