import { expect, spyOn, test } from "bun:test";
import { printHealth, buildHealthHtml } from "../src/health/report";
import type { HealthResult } from "../src/health/flow";
import * as output from "../src/terminal/output";

test("unavailable uses warning color in terminal output while NO_COLOR and HTML remain plain", () => {
  const result: HealthResult = { query: {}, providers: [{ name: "worker", namespace: "fixture",
    probes: [{ probe: "startup", scope: "self", status: "unavailable", observations: [], findings: [] }],
    endpoints: [{ source: "storage", status: "unavailable" }],
  }] };
  const force = process.env.FORCE_COLOR, noColor = process.env.NO_COLOR;
  const chunks: string[] = [];
  const writer = spyOn(output, "writeOutput").mockImplementation(chunk => { chunks.push(String(chunk)); return true; });
  try {
    process.env.FORCE_COLOR = "1"; delete process.env.NO_COLOR;
    printHealth(result);
    expect(chunks.join("").match(/\u001b\[33munavailable\u001b\[39m/g)).toHaveLength(2);
    chunks.length = 0;
    process.env.NO_COLOR = "1";
    printHealth(result);
    expect(chunks.join("")).toContain("unavailable");
    expect(chunks.join("")).not.toContain("\u001b");
    expect(buildHealthHtml(result)).not.toContain("\u001b");
  } finally {
    if (force === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = force;
    if (noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = noColor;
    writer.mockRestore();
  }
});
