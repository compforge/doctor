import { expect, spyOn, test } from "bun:test";
import { prepareHttpCases } from "../src/case/http";
import type { ArmContext } from "@compforge/perf-harness";
import { validateCaseSet } from "@compforge/spec-case/model";
import type { DoctorCaseSet } from "../src/case/catalog";
import { chooseServiceCases } from "../src/case/choices";
import { perfCaseMix, routePerfCases } from "../src/perf/selection";
import { perfAdapterFromCaseFactory } from "../src/perf";
import * as policy from "../src/terminal/policy";
import * as menu from "../src/terminal/selection";

test("grouped Case numbers route duplicate IDs to their own runner and judge", async () => {
  const groups: DoctorCaseSet[] = ["a", "b"].map(sourceId => ({
    source:"plugin", service:"chat-server", sourceId,
    caseSet:{caseset:"chat", cases:[{id:"hello", input:{query:sourceId}}, {id:"inspect", input:{}}]},
  }));
  const interactive = spyOn(policy, "isInteractive").mockReturnValue(true);
  const prompt = spyOn(menu, "promptListedChoice").mockImplementation(async request => request.match("1,2"));
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    const choices = await chooseServiceCases(groups,{browse:true, supports:(_, c) => !!c.input.query});
    const printed = output.mock.calls.map(args => args[0]).join("");
    expect(printed).toContain("chat-server / chat (a)");
    expect(printed).toContain("2) hello");
    expect(printed).toContain("（仅查看） inspect");
    const mix = perfCaseMix(choices!);
    validateCaseSet(mix.caseSet!);
    expect(new Set(mix.caseMix.map(c => c.id)).size).toBe(2);
    expect(mix.caseMix.map(c => c.weight)).toEqual([1,1]);
    expect(Object.values(mix.caseRefs)).toEqual(["a/chat/hello","b/chat/hello"]);
    const closed: string[] = [];
    const adapters = new Map(groups.map(g => [g, perfAdapterFromCaseFactory(g.sourceId!, async () => ({
      run:async ({input}) => {
        expect(input.id).toBe("hello");
        expect(input.input.query).toBe(g.sourceId);
        return {status:200,durationMs:1};
      },
      classify:() => ({ok:g.sourceId === "a", errorKind:"fixture"}),
      cleanup:async () => {closed.push(g.sourceId!);},
    }))]));
    const adapter = routePerfCases(mix, adapters);
    const ctx = {signal:new AbortController().signal,run_id:"test"} as ArmContext;
    await adapter.runner.setup!(ctx);
    const codes = [];
    for (const item of mix.caseSet!.cases) {
      const outcome = await adapter.runner.fire({...ctx, case:item});
      codes.push(adapter.judge({...outcome, case_id:item.id}).code);
    }
    expect(codes).toEqual(["success","fixture"]);
    await adapter.runner.cleanup!(ctx);
    expect(closed.sort()).toEqual(["a","b"]);
  } finally {
    output.mockRestore();
    prompt.mockRestore();
    interactive.mockRestore();
  }
});

test("HTTP selection preserves source and request identity across CaseSets", () => {
  const choices = ["public","admin"].map(name => {
    const item = {id:"ping", input:{path:"/" + name}};
    const source: DoctorCaseSet = {service:"store", source:"plugin", sourceId:"api", caseSet:{caseset:name, cases:[item]}};
    return {source, item};
  });
  const prepared = prepareHttpCases(choices,"http://127.0.0.1");
  expect(prepared.origin.refs).toEqual(["api/public/ping","api/admin/ping"]);
  expect(prepared.scenario.requests.map(r => [r.id, r.entrypoints[0]!.requestId, r.entrypoints[0]!.url])).toEqual([
    ["api:public:ping","api:public:ping","http://127.0.0.1/public"],
    ["api:admin:ping","api:admin:ping","http://127.0.0.1/admin"],
  ]);
});
