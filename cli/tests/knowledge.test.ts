import { describe, expect, spyOn, test } from "bun:test";
import { createServiceCatalog, type ErrorCatalogExtension, type PluginDefinition } from "@compforge/doctor-plugin";
import type { Command } from "commander";
import { createDoctorProgram } from "../src/app/main";
import { formatErrorCatalogs, queryErrorCatalogs } from "../src/knowledge/errors";

const errors: ErrorCatalogExtension = {
  id: "errors", kind: "error.catalog",
  load: () => ({ source: { name: "api", version: "1.2.3" }, errors: [
    { code: "001", name: "QueueBusy", description: "Queue full", aliases: ["CapacityExceeded"] },
    { code: "001", name: "TooManyJobs", description: "Job limit" },
  ] }),
};
const child: ErrorCatalogExtension = { ...errors, namespace: "plugin/example/service/worker" };
function plugin(extensions: readonly ErrorCatalogExtension[] = [errors, child]): PluginDefinition {
  return { id: "example", version: "0.1.0", services: createServiceCatalog([]), extensions };
}

async function run(args: string[], injected = plugin()): Promise<string> {
  let output = "";
  const write = spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
  const previous = process.exitCode;
  process.exitCode = 0;
  try {
    const program = createDoctorProgram({ plugin: injected });
    const capture = (command: Command): void => {
      command.exitOverride().configureOutput({ writeOut: value => { output += value; } });
      for (const child of command.commands) capture(child);
    };
    capture(program);
    await program.parseAsync(args, { from: "user" });
    expect(process.exitCode).toBe(0);
    return output;
  } finally { write.mockRestore(); process.exitCode = previous; }
}

describe("knowledge errors", () => {
  test("preserves every definition, catalog version and namespace for an ambiguous code", () => {
    const result = queryErrorCatalogs(plugin(), { query: "001" });
    expect(result.catalogs.map(c => [c.namespace, c.source.version, c.errors.length])).toEqual([
      ["plugin/example", "1.2.3", 2], ["plugin/example/service/worker", "1.2.3", 2],
    ]);
    expect(queryErrorCatalogs(plugin(), { query: "01" }).catalogs.every(c => c.errors.length === 0)).toBe(true);
  });
  test("matches names and aliases case insensitively", () => {
    for (const query of ["busy", "CAPACITY"]) {
      expect(queryErrorCatalogs(plugin([errors]), { query }).catalogs[0]?.errors.map(e => e.name)).toEqual(["QueueBusy"]);
    }
  });
  test("filters namespace exactly before loading catalogs", () => {
    const broken = { ...child, load: () => { throw new Error("must not load"); } };
    const result = queryErrorCatalogs(plugin([errors, broken]), { namespace: "plugin/example" });
    expect(result.catalogs).toHaveLength(1);
    expect(() => queryErrorCatalogs(plugin([broken]))).toThrow("must not load");
    expect(queryErrorCatalogs(plugin(), { namespace: "plugin/missing" }).catalogs).toEqual([]);
  });
  test("distinguishes no catalog from no matching definition", () => {
    expect(formatErrorCatalogs(queryErrorCatalogs(undefined))).toContain("No error catalogs declared");
    expect(formatErrorCatalogs(queryErrorCatalogs(plugin(), { query: "missing" }))).toContain("No error definition matches");
    expect(() => queryErrorCatalogs(plugin(), { query: "  " })).toThrow("must not be empty");
  });
  test("group help discovers errors without loading definitions", async () => {
    const output = await run(["knowledge"], plugin([{ ...errors, load: () => { throw new Error("must not load"); } }]));
    expect(output).toContain("errors [options] [query]");
  });
  test("real command queries offline despite unavailable config and kubeconfig", async () => {
    const output = await run(["--config", "/missing/doctor.yaml", "--kubeconfig", "/missing/kubeconfig",
      "knowledge", "errors", "001", "--extension-namespace", "plugin/example", "--format", "json"]);
    const result = JSON.parse(output);
    expect(result.catalogs).toHaveLength(1);
    expect(result.catalogs[0].errors).toHaveLength(2);
    expect(result.catalogs[0].source).toEqual({ name: "api", version: "1.2.3" });
  });
  test("global Kubernetes namespace does not filter offline definitions", async () => {
    const result = JSON.parse(await run(["--namespace", "kube-only", "knowledge", "errors", "-f", "json"]));
    expect(result.catalogs).toHaveLength(2);
    expect(result.namespace).toBeUndefined();
  });
  test("text lists definitions and empty search results remain successful", async () => {
    expect(await run(["knowledge", "errors"])).toContain("001 · QueueBusy");
    expect(await run(["knowledge", "errors", "missing"])).toContain("No error definition matches");
  });
});
