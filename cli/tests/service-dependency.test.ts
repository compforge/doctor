import { expect, test } from "bun:test";
import {
  openSearchDataSourceCandidates,
  prepareFirstAvailableDataSource,
  type ServiceDataSourceReference,
} from "../src/collect/shared/service-dependency";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";

const candidates: ServiceDataSourceReference[] = [
  { service: "jaeger-collector", dataSource: "trace" },
  { service: "kb-server", dataSource: "vdb" },
];

test("Service Store dependency 以声明项为首选并补齐其它 VDB target", () => {
  const plugin = {
    id: "multi-vdb",
    version: "0.0.1",
    services: createServiceCatalog([{
      name: "kb-server",
      workloads: [],
      capabilities: {
        dataSources: [{ id: "vdb", kind: "vdb", backend: "opensearch" }],
      },
    }, {
      name: "jaeger-collector",
      workloads: [],
      capabilities: {
        dataSources: [{ id: "trace", kind: "vdb", backend: "opensearch" }],
      },
    }]),
  } satisfies PluginDefinition;

  expect(openSearchDataSourceCandidates(plugin, candidates[0])).toEqual(candidates);
});

test("OpenSearch Store target 按 Plugin 顺序重试", async () => {
  const visited: string[] = [];
  const failures: string[] = [];
  const selected = await prepareFirstAvailableDataSource(
    candidates,
    async ({ service, dataSource }) => {
      visited.push(`${service}/${dataSource}`);
      if (service === "jaeger-collector") throw new Error("socket closed");
      return `${service}/${dataSource}`;
    },
    ({ service, dataSource }, reason) => failures.push(`${service}/${dataSource}: ${reason}`),
  );

  expect(selected).toBe("kb-server/vdb");
  expect(visited).toEqual(["jaeger-collector/trace", "kb-server/vdb"]);
  expect(failures).toEqual(["jaeger-collector/trace: socket closed"]);
});

test("所有 OpenSearch Store target 失败时汇总原因", async () => {
  expect(prepareFirstAvailableDataSource(
    candidates,
    async ({ service }) => { throw new Error(`${service} unavailable`); },
    () => {},
  )).rejects.toThrow(
    "jaeger-collector/trace: jaeger-collector unavailable；kb-server/vdb: kb-server unavailable",
  );
});
