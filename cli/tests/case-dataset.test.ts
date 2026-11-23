import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArmContext } from "@compforge/perf-harness";
import type { DoctorCaseSet } from "../src/case/catalog";
import { perfAdapterFromCaseFactory } from "../src/perf";
import { perfCaseMix, routePerfCases } from "../src/perf/selection";
import type { Case } from "@compforge/spec-case/model";
import { prepareCaseInput, previewCaseInput } from "../src/case/params";
import { loadCaseDataset } from "../src/perf/case-dataset";

const example: Case = {
  id: "ask", params: {
    query: {type: "string", default: "hello"},
    count: {type: "integer", default: 0},
    user: {type: "string", source: "command.user_id"},
  },
  input: {query: {$param: "query"}, nested: [{$param: "count"}, {$param: "user"}, false]},
};

test("CSV preserves quoted values and samples all referenced fields from one row per request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "doctor-case-dataset-"));
  try {
    const path = join(dir, "queries.csv");
    await writeFile(path, '\uFEFFquery,count\r\n"what, exactly?",1\r\n"line one\n""two""",2\r\n');
    const rows = await loadCaseDataset(path, [example]);
    const render = await prepareCaseInput(example, rows, {userId: "selected"});
    const source: DoctorCaseSet = { source: "plugin", service: "example", sourceId: "questions",
      caseSet: { caseset: "ask", cases: [example] } };
    const mix = perfCaseMix([{ source, item: example }]);
    const received: Case["input"][] = [];
    const adapter = perfAdapterFromCaseFactory("example", async () => ({
      run: async ({ input }) => { received.push(input.input); return {status: 200, durationMs: 1}; },
      classify: () => ({ok: true}),
    }));
    const { runner } = routePerfCases(mix, new Map([[source, adapter]]), new Map([[example, render!]]));
    const ctx = {signal: new AbortController().signal, run_id: "test"} as ArmContext;
    await runner.setup?.(ctx);
    const random = spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.9);
    try {
      await Promise.all([runner.fire({...ctx, case: example}), runner.fire({...ctx, case: example})]);
      expect(received).toEqual([
        {query: "what, exactly?", nested: [1, "selected", false]},
        {query: 'line one\n"two"', nested: [2, "selected", false]},
      ]);
    } finally { random.mockRestore(); await runner.cleanup?.(ctx); }
    expect(example.input.query).toEqual({$param: "query"});
    for (const csv of ["query\n", "query,query\na,b\n", "typo\nx\n", "query,count\nshort\n"]) {
      await writeFile(path, csv);
      await expect(loadCaseDataset(path, [example])).rejects.toThrow("--case-dataset");
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("defaults and literal inputs work without CSV; missing values prompt once before dispatch", async () => {
  const questions: string[] = [];
  const render = await prepareCaseInput(example, [], {}, async label => { questions.push(label); return "user"; });
  expect(render!().input).toEqual({query: "hello", nested: [0, "user", false]});
  expect(render!().input).toEqual(render!().input);
  expect(questions).toHaveLength(1);
  expect(previewCaseInput(example).input).toEqual({query: "hello", nested: [0, "<USER>", false]});
  expect(await prepareCaseInput(example, [], {}, async () => undefined)).toBeUndefined();
  await expect(prepareCaseInput(example, [{count:"1"}, {count:"oops"}], {userId:"x"})).rejects.toThrow("记录 2");
  await expect(prepareCaseInput({...example, input: {nested: [{$param:"missing"}]}}, [], {userId:"x"})).rejects.toThrow("missing");
});
