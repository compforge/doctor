import type { DataRun } from "../../packages/plugin/tests/extension-fixture";
import { withSummary } from "@compforge/doctor-plugin";
import { expect, mock, test } from "bun:test";
import {
  createServiceCatalog, type ServiceDefinition, type Model, type ModelQueryExtension,
  type ModelBackendInspectExtension, type ModelBackendValidateExtension,
  type ModelInvokeExtension, type ModelStreamExtension, type ServiceHttpResponse,
} from "@compforge/doctor-plugin";
import {
  extensionModelCatalog, extensionModelInference, modelCatalogExtensions, modelInferenceExtensions,
  type ModelExtensionContext
} from "../src/model/extensions";
import type { ManagedPluginContext } from "../src/plugin/context";

const endpoint = { host: "models", port: 8080 };
const target = { baseUrl: "http://models/v1", model: "test-model" };
const model: Model = { id: "m", name: "model", type: "llm", provider: "test" };
const response: ServiceHttpResponse = { ok: true, statusCode: 200, statusText: "OK", headers: {}, text: "{}", durationMs: 1 };
const query: ModelQueryExtension = { id: "query", kind: "model.query", endpoint, access: {}, run: withSummary({"title":"模型列表","fields":[{"label":"模型数","path":["length"]}]}, async () => [model]) };
const inspect: ModelBackendInspectExtension = {
  id: "inspect", kind: "model.backend.inspect", endpoint, access: {},
  run: withSummary({"title":"模型后端","fields":[{"label":"类型","path":["type"]},{"label":"名称","path":["name"]}]}, async () => ({ modelId: "m", modelName: "model", model: "m", type: "llm", provider: "test" }))
};
const validate: ModelBackendValidateExtension = {
  id: "validate", kind: "model.backend.validate", endpoint,
  access: { kubernetes: [{ requirement: "required", rule: { verb: "get", resource: "secrets" }, purpose: "backend validation" }] },
  run: withSummary({"title":"模型后端校验","fields":[{"label":"HTTP 状态","path":["status"]}]}, async () => response)
};
const invoke: ModelInvokeExtension = { id: "invoke", kind: "model.invoke", endpoint, access: {}, run: withSummary({"title":"模型调用","fields":[{"label":"HTTP 状态","path":["status"]}]}, async () => response) };
const service = (extensions: ServiceDefinition["extensions"]): ServiceDefinition => ({
  name: "models",
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: [],
  extensions
});
function contexts() {
  const controller = new AbortController();
  const dispose = mock(async () => { });
  const open = mock(async () => ({ signal: controller.signal, dispose } as unknown as ManagedPluginContext));
  return { controller, dispose, open };
}
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

test("native model discovery and backend inspection never execute active validation", async () => {
  const validateRun = mock(validate.run);
  const services = createServiceCatalog([service([query, inspect, { ...validate, run: validateRun }])]);
  const provider = modelCatalogExtensions(services, "models");
  const { open, dispose } = contexts();
  const seen: unknown[] = [];
  const catalog = extensionModelCatalog(provider, async (service, extension) => {
    seen.push(extension.access);
    if (extension.kind === "model.backend.validate") throw new Error("validation access denied");
    return open();
  });
  expect(open).not.toHaveBeenCalled();
  expect(await catalog.query({ identity: { kind: "tenant_id", value: "t" } })).toEqual([model]);
  const backend = await catalog.getBackend(model);
  expect(backend?.modelId).toBe("m");
  expect(validateRun).not.toHaveBeenCalled();
  expect(seen).toEqual([{}, {}]);
  expect(dispose).toHaveBeenCalledTimes(2);
  await expect(backend!.validate(1000)).rejects.toThrow("access denied");
  expect(validateRun).not.toHaveBeenCalled();
});

test("native validation and invocation carry their request and clean up after errors", async () => {
  const run = mock(validate.run);
  const services = createServiceCatalog([service([query, inspect, { ...validate, run }, invoke])]);
  const { open, dispose } = contexts();
  const catalog = extensionModelCatalog(modelCatalogExtensions(services, "models"), open);
  expect(await (await catalog.getBackend(model))!.validate(250)).toEqual(response);
  expect(run.mock.calls[0]?.[1]).toEqual({ model, timeoutMs: 250 });
  const inference = extensionModelInference(modelInferenceExtensions(services, "models"), target, 500, open);
  expect(await inference.invoke("/embeddings", { input: "text" })).toEqual(response);
  expect(dispose).toHaveBeenCalledTimes(3);
  const bad: ModelInvokeExtension = { ...invoke, run: async () => { throw new Error("upstream failed"); } };
  const failed = extensionModelInference(modelInferenceExtensions(createServiceCatalog([service([bad])]), "models"), target, 1, open);
  await expect(failed.invoke("/embeddings", {})).rejects.toThrow("upstream failed");
  expect(dispose).toHaveBeenCalledTimes(4);
});

test("model discovery rejects ambiguity and supports catalogs without backends", async () => {
  expect(() => modelCatalogExtensions(createServiceCatalog([service([query, { ...query, id: "other" }])]), "models")).toThrow("ambiguous");
  const { open } = contexts();
  const catalog = extensionModelCatalog(modelCatalogExtensions(createServiceCatalog([service([query])]), "models"), open);
  expect(await catalog.getBackend(model)).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
});

function streaming(run: DataRun<ModelStreamExtension>, contextFor: ModelExtensionContext) {
  const extension: ModelStreamExtension = { id: "stream", kind: "model.stream", access: {}, endpoint, run: withSummary({ title: "Fixture", fields: [] }, run) };
  return extensionModelInference(modelInferenceExtensions(createServiceCatalog([service([extension])]), "models"), target, 1000, contextFor);
}

test("stream context outlives response headers and closes after body completion", async () => {
  const { open, dispose } = contexts();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
  const inference = streaming(async () => ({ statusCode: 200, statusText: "OK", headers: {}, body }), open);
  const result = await inference.invokeStream("/chat/completions", {}, new AbortController().signal);
  expect(dispose).not.toHaveBeenCalled();
  const reader = result.body!.getReader();
  source.enqueue(new Uint8Array([1]));
  expect((await reader.read()).value).toEqual(new Uint8Array([1]));
  expect(dispose).not.toHaveBeenCalled();
  source.close();
  expect((await reader.read()).done).toBe(true);
  await turn();
  expect(dispose).toHaveBeenCalledTimes(1);
});

for (const reason of ["cancel", "request-abort", "parent-abort", "source-error"] as const) {
  test(`stream propagates ${reason} and releases its context`, async () => {
    const { open, dispose, controller } = contexts();
    const request = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = mock(() => { });
    const body = new ReadableStream<Uint8Array>({ start(value) { source = value; }, cancel });
    const inference = streaming(async () => ({ statusCode: 200, statusText: "OK", headers: {}, body }), open);
    const reader = (await inference.invokeStream("/chat/completions", {}, request.signal)).body!.getReader();
    if (reason === "cancel") await reader.cancel("consumer stopped");
    else {
      // Bun promise matchers wait immediately; trigger abort/error before asserting rejection.
      const reading = reader.read();
      if (reason === "request-abort") request.abort(new Error("request stopped"));
      if (reason === "parent-abort") controller.abort(new Error("parent stopped"));
      if (reason === "source-error") source.error(new Error("source stopped"));
      await expect(reading).rejects.toThrow("stopped");
    }
    await turn();
    expect(dispose).toHaveBeenCalledTimes(1);
    if (reason !== "source-error") expect(cancel).toHaveBeenCalledTimes(1);
  });
}

test("stream handles empty responses, failed opens and cancellation before access", async () => {
  const { open, dispose } = contexts();
  const empty = streaming(async () => ({ statusCode: 204, statusText: "No Content", headers: {}, body: null }), open);
  expect((await empty.invokeStream("/chat/completions", {}, new AbortController().signal)).body).toBeNull();
  expect(dispose).toHaveBeenCalledTimes(1);
  const failed = streaming(async () => { throw new Error("request failed"); }, open);
  await expect(failed.invokeStream("/chat/completions", {}, new AbortController().signal)).rejects.toThrow("request failed");
  expect(dispose).toHaveBeenCalledTimes(2);
  const cancelled = new AbortController(); cancelled.abort(new Error("cancelled"));
  await expect(empty.invokeStream("/chat/completions", {}, cancelled.signal)).rejects.toThrow("cancelled");
  expect(open).toHaveBeenCalledTimes(2);
});
