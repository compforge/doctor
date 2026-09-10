import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { ReportArchive, REPORT_ARCHIVE_SCRIPT } from "../src/collect/output/report-archive";

test("offline reader inflates the index and requested leaf only", () => {
  const writer = new ReportArchive();
  const first = writer.add("<p>中文证据</p>");
  const second = writer.add("<p>unopened evidence</p>");
  const embedded = writer.embed([{ key: "first", label: "first", status: "delivered", ...first },
    { key: "second", label: "second", status: "delivered", ...second }]);
  let removed = false;
  const sandbox = { Uint8Array, TextDecoder, TextEncoder, atob,
    document: { getElementById: () => ({ content: { textContent: embedded.split(">")[1]!.split("<")[0] }, remove: () => { removed = true; } }) },
  };
  const result = runInNewContext(REPORT_ARCHIVE_SCRIPT + `
    const opened=[];const inflate=fflate.unzipSync;
    fflate.unzipSync=(bytes,options)=>inflate(bytes,{filter:entry=>{const accepted=options.filter(entry);if(accepted)opened.push(entry.name);return accepted;}});
    const text=fflate.strFromU8(readReportEntry(reportIndex.tabs[0].entry));
    ({text,opened,remaining:encodedArchive});`, sandbox);
  expect(result.text).toBe("<p>中文证据</p>");
  expect([...result.opened]).toEqual([first.entry!]);
  expect(result.remaining).toBe("");
  expect(removed).toBe(true);
});
