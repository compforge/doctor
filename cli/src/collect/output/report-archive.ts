import { createHash } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
// A build-time text import keeps the offline reader inside compiled Doctor binaries.
import zipSource from "../../../node_modules/fflate/umd/index.js" with { type: "text" };

export interface ReportNavigation {
  key: string;
  label: string;
  status: "delivered" | "failed";
  entry?: string;
  tabs?: ReportNavigation[];
}
export interface ReportIndex { version: 1; tabs: ReportNavigation[] }
const OPEN = '<template id="doctor-report-archive">';

/** Only Doctor's versioned container is composed; domain HTML stays opaque. */
export function readReportArchive(html: string): { index: ReportIndex; entries: Record<string, Uint8Array> } | undefined {
  const start = html.indexOf(OPEN);
  if (start < 0) return undefined;
  const end = html.indexOf("</template>", start);
  if (end < 0) throw new Error("Incomplete Doctor report archive");
  const entries = unzipSync(Buffer.from(html.slice(start + OPEN.length, end), "base64"));
  const index = JSON.parse(strFromU8(entries["index.json"]!)) as ReportIndex;
  if (index.version !== 1 || !Array.isArray(index.tabs)) throw new Error("Unsupported Doctor report archive");
  delete entries["index.json"];
  return { index, entries };
}

/** @why Content-addressed leaves let aggregate reports reference the same evidence without embedding it again. */
export class ReportArchive {
  readonly entries: Record<string, Uint8Array> = {};

  add(html: string): Pick<ReportNavigation, "entry" | "tabs"> {
    const nested = readReportArchive(html);
    if (nested) {
      Object.assign(this.entries, nested.entries);
      return { tabs: nested.index.tabs };
    }
    const entry = `reports/${createHash("sha256").update(html).digest("hex")}.html`;
    this.entries[entry] ??= strToU8(html);
    return { entry };
  }

  embed(tabs: ReportNavigation[]): string {
    const data = zipSync({ ...this.entries, "index.json": strToU8(JSON.stringify({ version: 1, tabs })) }, { level: 6 });
    return `${OPEN}${Buffer.from(data).toString("base64")}</template>`;
  }
}

/** Remove a second navigation entry for a leaf already reachable through a sibling aggregate. */
export function normalizeReportTabs(tabs: ReportNavigation[]): ReportNavigation[] {
  const entriesOf = (tab: ReportNavigation): string[] => tab.entry ? [tab.entry] : (tab.tabs ?? []).flatMap(entriesOf);
  const covered = new Set(tabs.filter(tab => tab.tabs).flatMap(entriesOf));
  return tabs.filter(tab => !tab.entry || !covered.has(tab.entry)).map(tab =>
    tab.tabs ? { ...tab, tabs: normalizeReportTabs(tab.tabs) } : tab);
}

export const REPORT_ARCHIVE_SCRIPT = `${zipSource}
${String.raw`
const archiveElement=document.getElementById('doctor-report-archive');
let encodedArchive=archiveElement.content.textContent.trim();
const archiveBytes=new Uint8Array(encodedArchive.length*3/4-(encodedArchive.endsWith('==')?2:encodedArchive.endsWith('=')?1:0));
// Decode bounded slices; do not allocate a second full-size binary string or an Array of characters.
for(let start=0,offset=0;start<encodedArchive.length;start+=1048576){const part=atob(encodedArchive.slice(start,start+1048576));for(let i=0;i<part.length;i++)archiveBytes[offset++]=part.charCodeAt(i);}
archiveElement.remove();encodedArchive='';
function readReportEntry(name){const data=fflate.unzipSync(archiveBytes,{filter:entry=>entry.name===name})[name];if(!data)throw new Error('报告内容缺失：'+name);return data;}
const reportIndex=JSON.parse(fflate.strFromU8(readReportEntry('index.json')));
`}`;
