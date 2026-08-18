import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COLLECT_KINDS,
  parseCollectKinds,
  runCollectDelegates,
} from "../src/collect/composite";
import { collectPluginCapabilities } from "../src/app/plugin-command-capabilities";

test("collect include accepts comma or pipe separated command names", () => {
  expect(parseCollectKinds(undefined)).toEqual([...COLLECT_KINDS]);
  expect(parseCollectKinds("trace,log|data trace")).toEqual(["trace", "log", "data"]);
  expect(() => parseCollectKinds("trace,cpu")).toThrow("--include 仅支持");
});

test("collect capability contract is the union of selected concrete commands", () => {
  const contract = collectPluginCapabilities(["data", "trace", "log"]);
  expect(contract.command).toBe("doctor collect");
  expect(contract.needs.map((need) => `${need.capability.scope}.${need.capability.name}`))
    .toEqual(["service.data", "service.traceId", "service.log"]);
});

test("collect delegates concrete work and continues after one command fails", async () => {
  const staging = mkdtempSync(join(tmpdir(), "doctor-collect-test-"));
  const calls: string[] = [];
  try {
    const results = await runCollectDelegates(["data", "trace", "log"], staging, async (kind, outputPath) => {
      calls.push(kind);
      if (kind === "trace") throw new Error("trace unavailable");
      writeFileSync(outputPath, `<html>${kind}</html>`);
      return 0;
    });

    expect(calls).toEqual(["data", "trace", "log"]);
    expect(results.map((result) => [result.kind, result.code])).toEqual([
      ["data", 0],
      ["trace", 1],
      ["log", 0],
    ]);
    expect(results[1]?.error).toBe("trace unavailable");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});
