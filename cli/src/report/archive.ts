import { strToU8, zipSync } from "fflate";
import { createHash } from "node:crypto";
// A build-time text import keeps the offline reader inside compiled Doctor binaries.
import zipSource from "../../node_modules/fflate/umd/index.js" with { type: "text" };

const OPEN = '<template id="doctor-report-archive">';

/** @why Content-addressed leaves let aggregate reports reference the same evidence without embedding it again. */
export class ReportArchive {
  readonly entries: Record<string, Uint8Array> = {};

  /** Explicit report pages are opaque, including pages with their own embedded assets. */
  addPage(html: string): { entry: string } {
    const entry = `reports/${createHash("sha256").update(html).digest("hex")}.html`;
    this.entries[entry] ??= strToU8(html);
    return { entry };
  }

  embedIndex(index: unknown): string {
    const data = zipSync({ ...this.entries, "index.json": strToU8(JSON.stringify(index)) }, { level: 6 });
    return `${OPEN}${Buffer.from(data).toString("base64")}</template>`;
  }
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
