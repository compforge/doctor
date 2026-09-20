import { expect, mock, test } from "bun:test";
import { createServiceCatalog, modelBackendOutput, modelQueryOutput, modelResponseOutput, modelStreamOutput,
  type ServiceDefinition, type ModelQueryExtension } from "../src";

const endpoint = { host: "models", port: 8080 };
const base: ServiceDefinition = { name: "models", component: { name: "test", repository: { forge: { name: "test" }, path: "test" } }, workloads: [], capabilities: {} };

test("legacy model discovery adapts operations without creating clients", () => {
  const create = mock(() => ({ query: async () => [], getBackend: async () => undefined }));
  const service = { ...base, capabilities: { modelCatalog: { endpoint, access: {}, create } } };
  const catalog = createServiceCatalog([service]);
  for (const kind of ["model.query", "model.backend.inspect", "model.backend.validate"]) expect(catalog.extensions(kind)).toHaveLength(1);
  expect(create).not.toHaveBeenCalled();
  const extension: ModelQueryExtension = { id: "query", kind: "model.query", access: {}, endpoint, run: async () => [] };
  expect(() => createServiceCatalog([{ ...service, extensions: [extension] }])).toThrow("not both");
});

test("backend projection strips private and executable fields", () => {
  const publicData = { modelId: "m", modelName: "M", model: "m", type: "llm", provider: "p" };
  expect(modelBackendOutput({ ...publicData, apiKey: "private", validate: () => {} })).toEqual(publicData);
  expect(modelBackendOutput(undefined)).toBeUndefined();
  expect(() => modelBackendOutput({ modelId: "m" })).toThrow("invalid backend");
});

test("model results reject malformed dynamic outputs", () => {
  expect(() => modelQueryOutput([{}])).toThrow("model list");
  expect(() => modelResponseOutput({ statusCode: 200, statusText: "OK", headers: {} })).toThrow("body or duration");
  expect(() => modelStreamOutput({ statusCode: 200, statusText: "OK", headers: {}, body: "not a stream" })).toThrow("invalid body");
});
