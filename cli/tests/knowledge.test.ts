import { describe, expect, spyOn, test } from "bun:test";
import { createServiceCatalog, type Knowledge, type PluginDefinition } from "@compforge/doctor-plugin";
import type { Command } from "commander";
import { createDoctorProgram } from "../src/app/main";
import { knowledgeIndex, selectKnowledgeOwners } from "../src/knowledge/catalog";
import { lookupKnowledge, readKnowledge } from "../src/knowledge/read";

const knowledge: Knowledge = {
  concepts: [{ id: "job", name: "Job", description: "A Job owns attempts." }],
  workflows: [{ id: "run", title: "Run", summary: "Accept and execute.", steps: [
    { id: "save", parentId: "execute", title: "Save", description: "Persist result." },
    { id: "execute", title: "Execute", description: "Execute job." },
  ] }],
  articles: [{ id: "capacity", title: "Capacity", summary: "Queue investigation", sections: [
    { id: "check/queue", title: "Check queue", body: "Inspect depth." },
  ] }],
  dictionaries: [{ id: "errors", title: "Errors", summary: "Queue definitions",
    source: { name: "api", version: "1.2.3" }, entries: [
      { id: "001", name: "QueueBusy", description: "Queue full", aliases: ["CapacityExceeded"] },
      { id: "002", name: "QueueTimeout", description: "Queue expired" },
    ] }],
};
function plugin(): PluginDefinition {
  const component = { name: "test", repository: { forge: { name: "test" }, path: "fixtures/app" } };
  return { id: "example", version: "0.1.0", knowledge, services: createServiceCatalog([
    { name: "worker", aliases: ["work"], component, workloads: [], knowledge, upstream: ["api"] },
    { name: "api", component, workloads: [], knowledge },
  ]), validateConfig: () => { throw new Error("must remain offline"); } };
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

describe("structured knowledge", () => {
  test("defaults to Product; selected Services resolve aliases without Product inheritance", () => {
    expect(selectKnowledgeOwners(plugin()).map(owner => owner.namespace)).toEqual(["plugin/example"]);
    expect(selectKnowledgeOwners(plugin(), { services: ["worker", "work"] }).map(owner => owner.namespace))
      .toEqual(["plugin/example/service/worker"]);
    expect(() => selectKnowledgeOwners(plugin(), { all: true, services: ["api"] })).toThrow("--all");
    expect(() => selectKnowledgeOwners(plugin(), { services: ["missing"] })).toThrow("Unknown Service");
    expect(selectKnowledgeOwners(undefined)).toEqual([]);
  });
  test("references resolve roots, children and encoded IDs; ambiguous short refs require an owner", () => {
    expect(readKnowledge(plugin(), "article/capacity#check%2Fqueue").item).toEqual(knowledge.articles![0]!.sections[0]!);
    expect(readKnowledge(plugin(), "workflow/run#save").item).toHaveProperty("parentId", "execute");
    expect(readKnowledge(plugin(), "plugin/example/service/worker/concept/job").service).toBe("worker");
    expect(() => readKnowledge(plugin(), "concept/job", { services: ["api", "worker"] })).toThrow("Ambiguous");
    expect(() => readKnowledge(plugin(), "plugin/example/concept/job", { services: ["worker"] })).toThrow("out-of-scope");
    expect(() => readKnowledge(plugin(), "article/capacity#missing")).toThrow("Unknown Section");
    expect(() => readKnowledge(plugin(), "concept/job#child")).toThrow("no child");
    expect(() => readKnowledge(plugin(), "article/%broken")).toThrow("Invalid encoding");
  });
  test("lookup preserves opaque IDs and source version and matches names/aliases case insensitively", () => {
    expect(lookupKnowledge(plugin(), "errors", "001").entries.map(item => item.entry.id)).toEqual(["001"]);
    expect(lookupKnowledge(plugin(), "errors", "01").entries).toEqual([]);
    expect(lookupKnowledge(plugin(), "errors", "queue").entries).toHaveLength(2);
    expect(lookupKnowledge(plugin(), "errors", "CAPACITY").entries[0]?.entry.name).toBe("QueueBusy");
    expect(lookupKnowledge(plugin(), "errors", undefined).source?.version).toBe("1.2.3");
    expect(lookupKnowledge(plugin(), "errors", "missing").text).toContain("No entry matches");
    expect(() => lookupKnowledge(plugin(), "errors", " ")).toThrow("must not be empty");
  });
  test("index omits large object bodies", () => {
    const index = knowledgeIndex(selectKnowledgeOwners(plugin())[0]!);
    expect(index.items).toHaveLength(4);
    expect(JSON.stringify(index)).not.toContain("Inspect depth.");
  });
  test("commands stay offline with unavailable profile and kubeconfig; JSON omits generated text", async () => {
    const result = JSON.parse(await run(["--config", "/missing/config", "--kubeconfig", "/missing/kubeconfig",
      "knowledge", "lookup", "errors", "001", "-f", "json"]));
    expect(result.entries).toHaveLength(1);
    expect(result.source).toEqual({ name: "api", version: "1.2.3" });
    expect(result).not.toHaveProperty("text");
    expect(JSON.parse(await run(["knowledge", "show", "concept/job", "-f", "json"]))).not.toHaveProperty("text");
  });
  test("root and child options combine selections and inherit JSON format", async () => {
    const result = JSON.parse(await run(["knowledge", "-s", "work", "-f", "json", "list", "-s", "api", "--kind", "concept"]));
    expect(result.owners.map((owner: { service: string }) => owner.service)).toEqual(["worker", "api"]);
    expect(result.owners.every((owner: { items: unknown[] }) => owner.items.length === 1)).toBe(true);
    const all = JSON.parse(await run(["knowledge", "list", "--all", "-f", "json"]));
    expect(all.owners).toHaveLength(3);
  });
  test("overview expands model, indexes articles/dictionaries, and selected Service omits Product index", async () => {
    const overview = JSON.parse(await run(["knowledge", "-f", "json"]));
    expect(overview.owners[0].concepts).toEqual(knowledge.concepts);
    expect(overview.owners[0].articles[0]).not.toHaveProperty("sections");
    expect(overview.services).toHaveLength(2);
    const selected = JSON.parse(await run(["knowledge", "-s", "worker", "-f", "json"]));
    expect(selected).not.toHaveProperty("services");
    expect(selected.owners[0].upstream).toEqual(["api"]);
    expect(await run(["knowledge", "show", "workflow/run"])).toContain("Persist result.");
  });
});
