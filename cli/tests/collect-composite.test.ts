import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COLLECT_KINDS,
  parseCollectKinds,
  runCollect,
  runCollectDelegates,
} from "../src/collect/composite";
import { collectPluginCapabilities } from "../src/app/plugin-command-capabilities";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import { CommandContext } from "../src/command";
import { deliverCommandArtifacts } from "../src/app/delivery";

test("collect include accepts comma or pipe separated command names", () => {
  expect(parseCollectKinds(undefined)).toEqual([...COLLECT_KINDS]);
  expect(parseCollectKinds("trace,log|data trace")).toEqual(["trace", "log", "data"]);
  expect(() => parseCollectKinds("trace,cpu")).toThrow("--include 仅支持");
});

test("collect capability contract is the union of selected concrete commands", () => {
  const contract = collectPluginCapabilities(["inspect", "data", "trace", "log"]);
  expect(contract.command).toBe("doctor collect");
  expect(contract.needs.map((need) => `${need.capability.scope}.${need.capability.name}`))
    .toEqual(["plugin.tenantConfiguration", "service.data", "service.traceId", "service.log"]);
});

test("collect delegates concrete work and continues after one command fails", async () => {
  const calls: string[] = [];
  const results = await runCollectDelegates(["inspect", "data", "trace", "log"], async (kind) => {
    calls.push(kind);
    if (kind === "trace") throw new Error("trace unavailable");
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
});

test("collect default delivery contains combined HTML and child full bundles", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-collect-delivery-test-"));
  const output = join(root, "case");
  const plugin = {
    id: "test",
    version: "0.0.1",
    services: createServiceCatalog([]),
  } satisfies PluginDefinition;
  const context = new CommandContext({});
  try {
    const code = await runCollect({
      bizIds: ["biz-1"],
      kinds: ["inspect", "data"],
      output,
    }, plugin, context, async (kind) => {
      const artifact = join(root, `doctor-${kind}`);
      mkdirSync(artifact);
      writeFileSync(join(artifact, "report.html"), `<html>${kind}</html>`);
      writeFileSync(join(artifact, "evidence.txt"), `${kind} evidence`);
      context.artifacts.add(kind, artifact);
      return 0;
    });
    expect(code).toBe(0);
    expect(await deliverCommandArtifacts(context, { output }, code, "doctor collect")).toBe(true);

    expect(existsSync(`${output}.html`)).toBe(true);
    expect(existsSync(`${output}.tar.gz`)).toBe(true);
    expect(readFileSync(`${output}.html`, "utf8")).toContain("inspect");
    expect(readFileSync(`${output}.html`, "utf8")).toContain("data");
    const listing = Bun.spawnSync(["tar", "-tzf", `${output}.tar.gz`]).stdout.toString();
    expect(listing).toContain("doctor-inspect/report.html");
    expect(listing).toContain("doctor-data/report.html");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivery treats an unknown format as default and prints a warning", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-delivery-unknown-format-test-"));
  const artifact = join(root, "doctor-inspect");
  const output = join(root, "case");
  const context = new CommandContext({});
  const write = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    mkdirSync(artifact);
    writeFileSync(join(artifact, "report.html"), "<html>inspect</html>");
    writeFileSync(join(artifact, "evidence.txt"), "inspect evidence");
    context.artifacts.add("inspect", artifact);

    expect(await deliverCommandArtifacts(
      context,
      { format: "unknown", output },
      0,
      "doctor inspect",
    )).toBe(true);
    expect(existsSync(`${output}.html`)).toBe(true);
    expect(existsSync(`${output}.tar.gz`)).toBe(true);
    expect(write.mock.calls.map(([chunk]) => String(chunk)).join(""))
      .toContain("未识别 format 'unknown'，按 default 交付 HTML + Bundle");
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivery keeps repeated command reports under one command tab", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-collect-repeated-command-test-"));
  const output = join(root, "report.html");
  const context = new CommandContext({});
  try {
    for (const name of ["doctor-trace-1", "doctor-trace-2"]) {
      const artifact = join(root, name);
      mkdirSync(artifact);
      writeFileSync(join(artifact, "report.html"), `<html>${name}</html>`);
      context.artifacts.add("trace", artifact);
    }

    expect(await deliverCommandArtifacts(context, { format: "html", output }, 0, "doctor perf"))
      .toBe(true);
    const html = readFileSync(output, "utf8");
    expect(html).toContain("doctor-trace-1");
    expect(html).toContain("doctor-trace-2");
    expect(html).toContain("secondary-tabs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collect preserves staged evidence when default delivery fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-collect-delivery-failure-test-"));
  const output = join(root, "missing", "case");
  const plugin = {
    id: "test",
    version: "0.0.1",
    services: createServiceCatalog([]),
  } satisfies PluginDefinition;
  const write = spyOn(process.stderr, "write").mockImplementation(() => true);
  const context = new CommandContext({});
  let stagingDir: string | undefined;
  try {
    const code = await runCollect({
      bizIds: ["biz-1"],
      kinds: ["inspect"],
      output,
    }, plugin, context, async (kind) => {
      stagingDir = join(root, "doctor-inspect");
      mkdirSync(stagingDir);
      writeFileSync(join(stagingDir, "report.html"), "<html>inspect</html>");
      context.artifacts.add(kind, stagingDir);
      return 0;
    });
    expect(code).toBe(0);
    expect(await deliverCommandArtifacts(context, { output }, code, "doctor collect")).toBe(false);

    const stderr = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(stderr).toContain("原始产物保留在");
    expect(existsSync(join(stagingDir!, "report.html"))).toBe(true);
  } finally {
    write.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
