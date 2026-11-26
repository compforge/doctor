import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { writeServiceLogs, writeTimeline } from "../src/collect/log/timeline-file";
import { writeLogHtmlReport } from "../src/collect/log/html";

test("TXT failure preserves the committed timeline and all offline message chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "log-output-"));
  try {
    const records = Array.from({ length: 1025 }, (_, sequence) => ({
      kind: "log" as const, service: "api", pod: "api-1", instance: "current" as const, sequence,
      message: `line ${sequence}\n</script>`,
    }));
    await writeTimeline(dir, records);
    mkdirSync(join(dir, "service-logs.txt"));
    await expect(writeServiceLogs(dir, [], "test", ["api"])).rejects.toThrow();
    expect(readdirSync(dir).some(file => file.endsWith(".part"))).toBe(false);
    writeFileSync(join(dir, "collection.json"), "{}");
    const page = join(dir, "report.html");
    await writeLogHtmlReport(dir, page, "test");
    const html = readFileSync(page, "utf8");
    const chunks = Array.from(html.matchAll(/<template class="log-chunk" data-index="([^"]+)">([^<]+)<\/template>/g));
    const decode = (encoded: string) => JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString());
    const decoded = chunks.flatMap(([, index, texts]) => {
      const messages = decode(texts);
      return decode(index).map((record: object, offset: number) => ({ ...record, message: messages[offset] }));
    });
    expect(decoded).toEqual(records);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed legacy evidence shows the original error and the archived raw path without a collection record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "log-failure-"));
  try {
    mkdirSync(join(dir, "raw"));
    writeFileSync(join(dir, "raw", "pod.log"), "one\n");
    writeFileSync(join(dir, "raw", "facts.json"), "{}");
    writeFileSync(join(dir, "error.log"), "collect_exit_code=1\nreason=bad <input>\n");
    const page = join(dir, "report.html");
    await writeLogHtmlReport(dir, page, "test", "items/item-1");
    const html = readFileSync(page, "utf8");
    expect(html).toContain("bad &lt;input&gt;");
    expect(html).toContain("1 份原始日志");
    expect(html).toContain("items/item-1/raw/");
    expect(existsSync(join(dir, "timeline.jsonl"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
