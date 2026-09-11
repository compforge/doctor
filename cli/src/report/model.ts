import { aggregateCommandStatus } from "../command/result";
import type { CommandStatus } from "../command/status";

/** Reading structure is independent of command invocation and artifact directory layout. */
export interface Report {
  readonly title: string;
  readonly sections: readonly ReportSection[];
}

export interface ReportSubject {
  readonly key: string;
  readonly label: string;
}

export interface ReportPage {
  readonly id: string;
  readonly title: string;
  readonly status: CommandStatus;
  readonly subject?: ReportSubject;
  readonly source?: { readonly artifactId: string; readonly file: string };
  readonly reason?: string;
  readonly renderError?: string;
}

export interface ReportSection {
  readonly id: string;
  readonly title: string;
  readonly status: CommandStatus;
  readonly scope?: string;
  readonly pages: readonly ReportPage[];
}

/** Repeated references preserve navigation identity; byte deduplication belongs to the archive. */
export function composeReports(title: string, reports: readonly Report[]): Report {
  const sections = new Map<string, ReportSection>();
  for (const report of reports) for (const section of report.sections) {
    const previous = sections.get(section.id);
    sections.set(section.id, previous ? {
      ...previous,
      status: aggregateCommandStatus([previous.status, section.status]),
      pages: [...new Map([...previous.pages, ...section.pages].map(page => [JSON.stringify([page.id, page.subject?.key]), page])).values()],
    } : section);
  }
  return { title, sections: [...sections.values()] };
}
