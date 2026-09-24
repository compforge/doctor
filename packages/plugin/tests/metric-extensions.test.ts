import { withSummary } from "../src";
import { metricExtension } from "./extension-fixture";
import { expect, mock, test } from "bun:test";
import { createServiceCatalog, metricConfigurationOutput, requireMetricConfigurationExtension, type ServiceDefinition } from "../src";
const metric = { endpoint: { host: "app", port: 8080, path: "/metrics" }, metricNames: ["requests_total"], charts: [] };
const base: ServiceDefinition = {
  name: "app",
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: []
};

test("legacy Metric is adapted as a zero-access configuration function", async () => {
  const services = createServiceCatalog([{
    ...base,
    extensions: [metricExtension(metric)]
  }]);
  const extension = requireMetricConfigurationExtension(services.extensions("metric.configuration")[0]!.extension);
  expect(extension.access).toEqual({});
  // The static adapter has no context dependencies.
  expect((await extension.run({} as never, undefined)).data).toBe(metric);
  expect(() => createServiceCatalog([{
    ...base,
    extensions: [extension,
      metricExtension(metric)]
  }])).toThrow("duplicate");
});

test("native discovery does not invoke configuration", () => {
  const run = mock(async () => metric);
  const services = createServiceCatalog([{ ...base, extensions: [{ id: "metrics", kind: "metric.configuration", access: {}, run: withSummary({ title: "Metrics", fields: [] }, run) }] }]);
  expect(services.extensions("metric.configuration")).toHaveLength(1);
  expect(run).not.toHaveBeenCalled();
});

test("configuration validation rejects malformed endpoints and query definitions", () => {
  expect(metricConfigurationOutput(metric)).toBe(metric);
  expect(() => metricConfigurationOutput({ ...metric, endpoint: { ...metric.endpoint, port: 0 } })).toThrow("invalid configuration");
  expect(() => metricConfigurationOutput({ ...metric, charts: [{}] })).toThrow("invalid query");
  expect(() => metricConfigurationOutput({ ...metric, detectors: [{ id: "bad", title: "Bad", query: { instant: "up", range: "up" }, threshold: NaN }] })).toThrow("invalid detector");
});
