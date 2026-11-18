import { expect, spyOn, test } from "bun:test";
import { caseCurlPreview, prepareHttpCases } from "../src/case/http";
import type { ArmContext } from "@compforge/perf-harness";
import { validateCaseSet } from "@compforge/spec-case/model";
import type { DoctorCaseSet } from "../src/case/catalog";
import { caseRef, resolveCaseChoices } from "../src/case/choices";
import { chooseServiceCases, printCaseDetails } from "../src/terminal/case-selection";
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
  const prompt = spyOn(menu, "promptListedChoice").mockImplementation(async request => request.match("1,2,3"));
  const output = spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    const selected = await chooseServiceCases(groups,{browse:true, supports:(_, c) => !!c.input.query});
    printCaseDetails(selected!);
    const choices = selected!.filter(c => !!c.item.input.query);
    const printed = output.mock.calls.map(args => args[0]).join("");
    expect(printed).toContain("chat-server / chat (a)");
    expect(printed).toContain("3) hello");
    expect(printed).toContain("2) inspect");
    expect(printed).toContain("a/chat/inspect（仅预览）\ncURL：此 Case 未提供离线 HTTP 请求模板。");
    const [first, second] = choices!;
    expect(() => resolveCaseChoices(choices!, ["hello"])).toThrow("重名");
    expect(resolveCaseChoices(choices!, [caseRef(second!), caseRef(first!), caseRef(second!)]))
      .toEqual([second!, first!]);
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

test("curl preview quotes the path and references body files without opening them", () => {
  const item = {id:"upload", input:{method:"POST", path:"/upload?q=one&n=2", body_file:"missing.bin"}};
  const source: DoctorCaseSet = {service:"files", source:"local", file:"/fixtures/cases.yaml", caseSet:{caseset:"files",cases:[item]}};
  const [curl] = caseCurlPreview({source,item});
  expect(curl).toContain('--data-binary \'@/fixtures/missing.bin\'');
  expect(curl).toContain('"\${BASE_URL:?set BASE_URL}"\'/upload?q=one&n=2\'');
  expect(caseCurlPreview({source,item},"http://localhost:8000")[0]).toContain("'http://localhost:8000/upload?q=one&n=2'");
});
