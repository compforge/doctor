import { expect, mock, test } from "bun:test";
import { createServiceCatalog, requireTraceResolveExtension, traceResolveOutput,
  type ServiceDefinition, type TraceResolveExtension } from "../src";

const base: ServiceDefinition = { name: "test", component: { name: "test", repository: { forge: { name: "test" }, path: "test" } }, workloads: [], capabilities: {} };
const trace: TraceResolveExtension = { id: "trace", kind: "trace.resolve", access: {}, endpoint: { host: "test", port: 80 }, run: async () => undefined };

test("discovery exposes trace and overview operations without executing a provider", () => {
  const call = mock(async () => undefined);
  const catalog = createServiceCatalog([{ ...base, extensions: [{ ...trace, run: call }] }]);
  expect(catalog.extensions("trace.resolve")).toHaveLength(1);
  expect(call).not.toHaveBeenCalled();
});

test("legacy declaration adaptation rejects competing explicit implementations", () => {
  const service = { ...base, capabilities: { traceId: { access: {}, endpoint: trace.endpoint, resolve: trace.run } } };
  expect(createServiceCatalog([service]).extensions("trace.resolve")).toHaveLength(1);
  expect(() => createServiceCatalog([{ ...service, extensions: [trace] }])).toThrow("not both");
});

test("trace domain rejects invalid endpoints and untyped results before consumers use them", () => {
  expect(() => requireTraceResolveExtension({ ...trace, endpoint: { host: "test", port: 0 } } as TraceResolveExtension)).toThrow("endpoint");
  expect(traceResolveOutput(undefined)).toEqual([]);
  expect(traceResolveOutput({ traceId: "id", resolvedAs: "message" })).toHaveLength(1);
  expect(() => traceResolveOutput([{ traceId: 42, resolvedAs: "message" }])).toThrow("invalid resolution");
});
