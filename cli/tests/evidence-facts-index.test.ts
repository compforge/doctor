import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceBundle } from "../src/collect/evidence";
import { readFacts } from "../src/collect/evidence-reader";
import { writeHtmlReport } from "../src/collect/output/report/writer";
import { RenderContext } from "../src/report/context";
import { writeEvidencePage } from "../src/report/evidence";

const roots: string[] = [];
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), "doctor-facts-index-test-"));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function persist(dir: string, facts: Record<string, unknown>) {
  const bundle = new EvidenceBundle(dir);
  bundle.writeCollection({ doctorVersion: "test", target: { service: "sample" }, params: {},
    inspectionFacts: facts, startedAt: "now", finishedAt: "now", files: { details: "details.json" } });
  return JSON.parse(readFileSync(join(dir, "collection.json"), "utf8"));
}

test("large structured Facts stay intact in raw while manifest remains an index", () => {
  const dir = temporary();
  const facts = { message: { content: "完整正文".repeat(150_000), tail: "facts-tail-marker" } };
  const manifest = persist(dir, facts);
  expect(manifest).not.toHaveProperty("inspection_facts");
  expect(manifest.files).toEqual({ details: "details.json", facts: "raw/facts.json" });
  expect(readFileSync(join(dir, "collection.json"), "utf8").length).toBeLessThan(1_000);
  expect(readFacts<typeof facts>(dir, manifest)).toEqual(facts);
  expect(readFileSync(join(dir, manifest.files.facts), "utf8")).not.toContain("[doctor: truncated");
});

test("relocated evidence renders from indexed raw through both render entrypoints", () => {
  const source = temporary(), destination = join(temporary(), "artifact");
  const manifest = persist(source, { detail: "indexed-facts-render-marker" });
  cpSync(source, destination, { recursive: true });
  rmSync(source, { recursive: true });
  expect(readFacts<{ detail: string }>(destination, manifest)).toEqual({ detail: "indexed-facts-render-marker" });
  const options = { title: "Indexed evidence", summaryHtml: "summary" };
  const artifact = { id: "a", command: "data", path: destination };
  const context = new RenderContext([artifact], "test");
  const before = readFileSync(join(destination, "collection.json"), "utf8");
  writeEvidencePage(context, artifact, options);
  expect(readFileSync(join(destination, "report.html"), "utf8")).toContain("indexed-facts-render-marker");
  writeHtmlReport(destination, join(destination, "standalone.html"), { ...options, profileName: "test" });
  expect(readFileSync(join(destination, "standalone.html"), "utf8")).toContain("indexed-facts-render-marker");
  expect(readFileSync(join(destination, "collection.json"), "utf8")).toBe(before);
});

test("missing, malformed and escaping Facts references fail instead of hiding unavailable evidence", () => {
  const dir = temporary();
  const manifest = persist(dir, {});
  writeFileSync(join(dir, manifest.files.facts), "{broken");
  expect(() => readFacts(dir, manifest)).toThrow();
  rmSync(join(dir, manifest.files.facts));
  expect(() => readFacts(dir, manifest)).toThrow();
  expect(() => readFacts(dir, { files: { facts: "../outside.json" } })).toThrow("outside");
});
