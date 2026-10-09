import { expect, test } from "bun:test";
import { caseHash } from "@compforge/spec-case/model";
import { MODEL_CASE_SET, MODEL_CONNECTIVITY_CASE_SET, modelHttpCases, modelConnectivityCases, validateCaseProduceResult, type Model } from "../src";

const model: Model = { id: "model-1", name: "Example", type: "llm", provider: "example",
  inference: { baseUrl: "https://inference.test/v1/", model: "endpoint-1" } };

test("model Health reuses functional stimuli, preserving separate throughput Cases", () => {
  expect(modelConnectivityCases(model).map(item => item.id)).toEqual(["llm_connectivity", "llm_adjacent_assistants", "llm_adjacent_users"]);
  expect(modelConnectivityCases({ ...model, inputModalities: ["text", "image"] }).map(item => item.id)).toContain("llm_image");
  expect(modelConnectivityCases({ ...model, type: "embedding" })).toHaveLength(1);
  expect(modelConnectivityCases({ ...model, type: "rerank" })).toHaveLength(1);
  expect(modelConnectivityCases({ ...model, type: "audio" })).toHaveLength(0);
  expect(MODEL_CASE_SET.cases.filter(item => item.facets?.mode === "performance").map(item => item.id))
    .toEqual(["prefill_short", "prefill_medium", "prefill_long", "decode"]);
});

test("producer binding preserves API prefixes and injects model only into runtime requests", () => {
  const cases = modelHttpCases(model);
  expect(() => validateCaseProduceResult({ cases }, 10)).not.toThrow();
  const first = cases[0]!;
  expect(caseHash(first.case)).toBe(caseHash(MODEL_CONNECTIVITY_CASE_SET.cases.find(item => item.id === first.case.id)!));
  expect(first.case.input.path).toBeUndefined();
  expect(first.targets[0]!.url).toBe("https://inference.test/v1/chat/completions");
  expect(JSON.parse(first.targets[0]!.body!)).toMatchObject({ model: "endpoint-1", stream: false });
  expect(JSON.parse(first.case.input.body!)).not.toHaveProperty("model");
  expect(JSON.parse(cases[1]!.targets[0]!.body!).messages.map((message: { role: string }) => message.role))
    .toEqual(["system", "user", "assistant", "assistant", "user"]);
  const relocated = modelHttpCases({ ...model, inference: { baseUrl: "http://elsewhere.test/api/v1", model: "other-endpoint" } });
  expect(caseHash(first.case)).toBe(caseHash(relocated[0]!.case));
  const another = modelHttpCases({ ...model, id: "another" });
  expect(cases.map(item => item.case.id)).toEqual(another.map(item => item.case.id));
  expect(first.subject?.id).toBe(model.id);
  expect(another[0]!.subject?.id).toBe("another");
  expect(() => validateCaseProduceResult({ cases: [...cases, ...another] }, 10)).not.toThrow();
});

test("invalid or unsupported model targets fail explicitly instead of becoming empty success", () => {
  expect(() => modelHttpCases({ ...model, type: "audio" })).toThrow("No Health Cases");
  expect(() => modelHttpCases({ ...model, inference: undefined })).toThrow("inference");
  for (const baseUrl of ["file:///tmp/model", "https://user:secret@example.test", "https://example.test?api_key=secret", "https://example.test/#fragment"]) {
    expect(() => modelHttpCases({ ...model, inference: { baseUrl, model: "endpoint" } })).toThrow("credential-free");
  }
});
