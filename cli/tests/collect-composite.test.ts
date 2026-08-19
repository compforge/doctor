import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COLLECT_KINDS,
  collectReportName,
  parseCollectKinds,
  runCollect,
  runCollectDelegates,
} from "../src/collect/composite";
import { collectPluginCapabilities } from "../src/app/plugin-command-capabilities";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { CommandContext } from "../src/command";

test("collect include accepts comma or pipe separated command names", () => {
  expect(parseCollectKinds(undefined)).toEqual([...COLLECT_KINDS]);
  expect(parseCollectKinds("trace,log|data trace")).toEqual(["trace", "log", "data"]);
  expect(() => parseCollectKinds("trace,cpu")).toThrow("--include 仅支持");
});

test("collect output name includes one safe biz-id and uses batch for multiple IDs", () => {
  const now = new Date(2026, 7, 19, 15, 4, 5);
  expect(collectReportName(["conversation/abc:123"], now))
    .toBe("doctor-collect-conversation-abc-123-20260819-150405");
  expect(collectReportName(["biz-1", "biz-2"], now))
    .toBe("doctor-collect-batch-20260819-150405");
});

test("collect capability contract is the union of selected concrete commands", () => {
  const contract = collectPluginCapabilities(["inspect", "data", "trace", "log"]);
  expect(contract.command).toBe("doctor collect");
  expect(contract.needs.map((need) => `${need.capability.scope}.${need.capability.name}`))
    .toEqual(["plugin.tenantConfiguration", "service.data", "service.traceId", "service.log"]);
});

test("collect delegates concrete work and continues after one command fails", async () => {
  const staging = mkdtempSync(join(tmpdir(), "doctor-collect-test-"));
  const calls: string[] = [];
  try {
    const results = await runCollectDelegates(["inspect", "data", "trace", "log"], staging, async (kind, outputPath) => {
      calls.push(kind);
      if (kind === "trace") throw new Error("trace unavailable");
      writeFileSync(outputPath, `<html>${kind}</html>`);
      return 0;
    });

    expect(calls).toEqual(["inspect", "data", "trace", "log"]);
    expect(results.map((result) => [result.kind, result.code])).toEqual([
      ["inspect", 0],
      ["data", 0],
      ["trace", 1],
      ["log", 0],
    ]);
    expect(results[2]?.error).toBe("trace unavailable");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test("collect default delivery contains combined HTML and child full bundles", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-collect-delivery-test-"));
  const output = join(root, "case");
  const plugin = {
    id: "test",
    version: "0.0.1",
    services: createServiceCatalog([]),
  } satisfies PluginDefinition;
  try {
    expect(await runCollect({
      bizIds: ["biz-1"],
      kinds: ["inspect", "data"],
      output,
    }, plugin, new CommandContext({}), async (kind, outputPath) => {
      writeFileSync(outputPath, `<html>${kind}</html>`);
      writeFileSync(outputPath.replace(/\.html$/, ".tar.gz"), `${kind} evidence`);
      return 0;
    })).toBe(0);

    expect(existsSync(`${output}.html`)).toBe(true);
    expect(existsSync(`${output}.tar.gz`)).toBe(true);
    const listing = Bun.spawnSync(["tar", "-tzf", `${output}.tar.gz`]).stdout.toString();
    expect(listing).toContain("/report.html");
    expect(listing).toContain("/inspect.tar.gz");
    expect(listing).toContain("/data.tar.gz");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
