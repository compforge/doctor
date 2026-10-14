import { articleToMarkdown, conceptToMarkdown, dictionaryToMarkdown, entryToMarkdown, knowledgeToMarkdown, sectionToMarkdown, stepToMarkdown, workflowToMarkdown } from "@compforge/doctor-plugin";
import { describe, expect, spyOn, test } from "bun:test";
import { createServiceCatalog, type Knowledge, type PluginDefinition } from "@compforge/doctor-plugin";
import type { Command } from "commander";
import { createDoctorProgram } from "../src/app/main";
import { knowledgeIndex, selectKnowledgeOwners } from "../src/knowledge/catalog";
import { lookupKnowledge, readKnowledge } from "../src/knowledge/read";
import { searchKnowledge } from "../src/knowledge/search";

const knowledge: Knowledge = {
  markdown() { return knowledgeToMarkdown(this); },
  concepts: [{ markdown() { return conceptToMarkdown(this); }, id: "job", name: "Job", description: "A Job owns attempts." }],
  workflows: [{ markdown() { return workflowToMarkdown(this); }, id: "run", title: "Run", summary: "Accept and execute.", steps: [
    { markdown() { return stepToMarkdown(this); }, id: "save", parentId: "execute", title: "Save", description: "Persist result." },
    { markdown() { return stepToMarkdown(this); }, id: "execute", title: "Execute", description: "Execute job." },
  ] }],
  articles: [{ markdown() { return articleToMarkdown(this); }, id: "capacity", title: "Capacity", summary: "Queue investigation", sections: [
    { markdown() { return sectionToMarkdown(this); }, id: "check/queue", title: "Check queue", body: "Inspect depth." },
  ] }],
  dictionaries: [{ markdown() { return dictionaryToMarkdown(this); }, id: "errors", title: "Errors", summary: "Queue definitions",
    source: { name: "api", version: "1.2.3" }, entries: [
      { markdown() { return entryToMarkdown(this); }, id: "001", name: "QueueBusy", description: "Queue full", aliases: ["CapacityExceeded"] },
      { markdown() { return entryToMarkdown(this); }, id: "002", name: "QueueTimeout", description: "Queue expired" },
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
    expect(overview.owners[0].concepts).toEqual(JSON.parse(JSON.stringify(knowledge.concepts)));
    expect(overview.owners[0].articles[0]).not.toHaveProperty("sections");
    expect(overview.services).toHaveLength(2);
    const selected = JSON.parse(await run(["knowledge", "-s", "worker", "-f", "json"]));
    expect(selected).not.toHaveProperty("services");
    expect(selected.owners[0].upstream).toEqual(["api"]);
    expect(await run(["knowledge", "show", "workflow/run"])).toContain("Persist result.");
  });
});


test("show and lookup preserve custom object and nested Markdown", async () => {
  const custom: Knowledge = {
    ...knowledge,
    concepts: [{ ...knowledge.concepts![0]!, markdown() { return "Custom concept"; } }],
    workflows: [{ ...knowledge.workflows![0]!, steps: [
      { ...knowledge.workflows![0]!.steps[1]!, markdown() { return "Custom step"; } },
    ] }],
    articles: [{ ...knowledge.articles![0]!, sections: [
      { ...knowledge.articles![0]!.sections[0]!, markdown() { return "Custom section"; } },
    ] }],
    dictionaries: [{ ...knowledge.dictionaries![0]!, entries: [
      { ...knowledge.dictionaries![0]!.entries[0]!, markdown() { return "Custom entry"; } },
    ] }],
  };
  const injected = { ...plugin(), knowledge: custom };
  for (const [ref, content] of [
    ["concept/job", "Custom concept"], ["workflow/run", "Custom step"], ["workflow/run#execute", "Custom step"],
    ["article/capacity", "Custom section"], ["article/capacity#check%2Fqueue", "Custom section"],
    ["dictionary/errors", "Custom entry"], ["dictionary/errors#001", "Custom entry"],
  ]) expect(await run(["knowledge", "show", ref!], injected)).toContain(content!);
  expect(await run(["knowledge", "lookup", "errors", "001"], injected)).toContain("Custom entry");
});

test("overview, JSON, index and search commands do not invoke Markdown methods", async () => {
  const noRender = () => { throw new Error("Markdown must not run for structured output"); };
  const custom: Knowledge = {
    markdown: noRender,
    concepts: knowledge.concepts!.map(item => ({ ...item, markdown: noRender })),
    workflows: knowledge.workflows!.map(item => ({ ...item, markdown: noRender,
      steps: item.steps.map(step => ({ ...step, markdown: noRender })) })),
    articles: knowledge.articles!.map(item => ({ ...item, markdown: noRender,
      sections: item.sections.map(section => ({ ...section, markdown: noRender })) })),
    dictionaries: knowledge.dictionaries!.map(item => ({ ...item, markdown: noRender,
      entries: item.entries.map(entry => ({ ...entry, markdown: noRender })) })),
  };
  const injected = { ...plugin(), knowledge: custom };
  for (const args of [[], ["list"], ["search", "queue"], ["show", "concept/job"], ["show", "workflow/run#save"],
    ["show", "article/capacity#check%2Fqueue"], ["show", "dictionary/errors"], ["lookup", "errors", "001"]]) {
    const output = JSON.parse(await run(["knowledge", ...args, "-f", "json"], injected));
    expect(JSON.stringify(output)).not.toContain("markdown");
  }
  const overview = await run(["knowledge", "-s", "work"], injected);
  expect(overview).toContain("plugin/example/service/worker\nUpstream: api\n\nConcept\n• Job：A Job owns attempts.");
  expect(overview).toContain("Workflow\nRun（run）\nAccept and execute.\n1. Execute：Execute job.\n  1. Save：Persist result.");
  expect(overview).toContain("Article\n• article/capacity — Capacity\n\nDictionary\n• dictionary/errors — Errors");
  expect(overview).not.toContain("plugin/example/service/worker/article/capacity");
  expect(overview).not.toContain("Inspect depth.");
  expect(await run(["knowledge", "show", "article/capacity", "-s", "work"], plugin())).toContain("Inspect depth.");
  expect(await run(["knowledge", "list"], injected)).toContain("concept/job");
  expect(await run(["knowledge", "search", "queue"], injected)).toContain("article/capacity#check%2Fqueue");
});


describe("knowledge search", () => {
  test("searches Product and all Services by default; explicit Service aliases exclude Product", () => {
    expect(searchKnowledge(plugin(), "attempts").matches.map(match => match.namespace)).toEqual([
      "plugin/example", "plugin/example/service/worker", "plugin/example/service/api",
    ]);
    expect(searchKnowledge(plugin(), "attempts", { services: ["worker", "work"] }).matches.map(match => match.namespace))
      .toEqual(["plugin/example/service/worker"]);
    expect(searchKnowledge(plugin(), "attempts", { services: ["api", "work"] }).matches.map(match => match.namespace))
      .toEqual(["plugin/example/service/worker", "plugin/example/service/api"]);
    expect(() => searchKnowledge(plugin(), "queue", { services: ["missing"] })).toThrow("Unknown Service");
  });

  test("finds structured roots and leaves with references that can be read directly", () => {
    for (const [query, suffix] of [
      ["attempts", "concept/job"], ["accept", "workflow/run"], ["persist", "workflow/run#save"],
      ["investigation", "article/capacity"], ["depth", "article/capacity#check%2Fqueue"],
      ["1.2.3", "dictionary/errors"], ["CAPACITYEXCEEDED", "dictionary/errors#001"],
    ]) {
      const result = searchKnowledge(plugin(), query!);
      expect(result.matches.map(match => match.ref)).toEqual([
        `plugin/example/${suffix}`, `plugin/example/service/worker/${suffix}`, `plugin/example/service/api/${suffix}`,
      ]);
      for (const match of result.matches) expect(readKnowledge(plugin(), match.ref).ref).toBe(match.ref);
    }
    const leaf = searchKnowledge(plugin(), "depth").matches[0]!;
    expect(leaf).toMatchObject({ kind: "article", id: "capacity", childKind: "section", childId: "check/queue" });
  });

  test("normalizes whitespace and requires every case-insensitive term in the same object", () => {
    const result = searchKnowledge(plugin(), "  QUEUE\n  full  ");
    expect(result.query).toBe("QUEUE full");
    expect(result.matches.map(match => match.ref)).toEqual([
      "plugin/example/dictionary/errors#001", "plugin/example/service/worker/dictionary/errors#001",
      "plugin/example/service/api/dictionary/errors#001",
    ]);
    expect(searchKnowledge(plugin(), "accept persist").matches).toEqual([]);
    expect(searchKnowledge(plugin(), "attempts expired").matches).toEqual([]);
    expect(searchKnowledge(plugin(), "not-present").matches).toEqual([]);
    expect(searchKnowledge(undefined, "queue").matches).toEqual([]);
    expect(() => searchKnowledge(plugin(), " \n ")).toThrow("must not be empty");
  });

  test("keeps bounded context around a match in a long body", () => {
    const body = `${"prefix ".repeat(100)}needle ${"suffix ".repeat(100)}`;
    const custom: Knowledge = { ...knowledge, articles: [{ ...knowledge.articles![0]!, sections: [
      { ...knowledge.articles![0]!.sections[0]!, body },
    ] }] };
    const result = searchKnowledge({ ...plugin(), knowledge: custom }, "needle");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.snippet).toContain("needle");
    expect(result.matches[0]!.snippet.length).toBeLessThanOrEqual(200);
    expect(result.matches[0]!.snippet).toMatch(/^….*…$/u);
  });

  test("CLI search stays offline, merges repeated parent/child Services and inherits format", async () => {
    const all = JSON.parse(await run(["--config", "/missing/config", "--kubeconfig", "/missing/kubeconfig",
      "knowledge", "search", "attempts", "-f", "json"]));
    expect(all.matches.map((match: { namespace: string }) => match.namespace)).toEqual([
      "plugin/example", "plugin/example/service/worker", "plugin/example/service/api",
    ]);
    const selected = JSON.parse(await run(["knowledge", "-s", "work", "-f", "json", "search", "attempts",
      "--service", "api", "--service", "worker"]));
    expect(selected.matches.map((match: { service: string }) => match.service)).toEqual(["worker", "api"]);
    expect(await run(["knowledge", "search", "not-present"])).toContain("No knowledge matches");
    const text = await run(["knowledge", "search", "depth", "-s", "work"]);
    expect(text).toContain("plugin/example/service/worker/article/capacity#check%2Fqueue");
    expect(text).toContain("Inspect depth.");
    expect(text).not.toContain("plugin/example/service/api");
  });

  test("distribution help points AI from search to knowledge and runtime evidence", () => {
    const program = createDoctorProgram({ name: "ascli", plugin: plugin() });
    const command = program.commands.find(command => command.name() === "knowledge")!;
    const helpFor = (command: Command): string => {
      let output = "";
      command.configureOutput({ writeOut: value => { output += value; } }).outputHelp();
      return output;
    };
    const help = helpFor(command);
    expect(help).toContain('ascli knowledge search "runtime error"');
    expect(help).toContain("AI 排查路径");
    expect(help).toContain("inspect/collect");
    const search = command.commands.find(command => command.name() === "search")!;
    expect(search.helpInformation()).toContain("默认产品和全部 Service");
    expect(helpFor(search)).toContain("knowledge show <ref>");
    expect(helpFor(program.commands.find(command => command.name() === "plugin")!)).toContain("knowledge search/show");
  });
});
