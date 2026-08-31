import { expect, test } from "bun:test";
import {
  openSearchStoreCandidates,
  prepareFirstAvailableStore,
  type ServiceStoreReference,
} from "../src/collect/shared/service-dependency";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";

const candidates: ServiceStoreReference[] = [
  { service: "jaeger-collector", store: "trace" },
  { service: "kb-server", store: "vdb" },
];

test("Service Store dependency 以声明项为首选并补齐其它 VDB target", () => {
  const plugin = {
    id: "multi-vdb",
    version: "0.0.1",
    services: createServiceCatalog([{
      name: "kb-server",
      workloads: [],
      capabilities: {
        stores: [{ id: "vdb", kind: "vdb", backend: "opensearch" }],
      },
    }, {
      name: "jaeger-collector",
      workloads: [],
      capabilities: {
        stores: [{ id: "trace", kind: "vdb", backend: "opensearch" }],
      },
    }]),
  } satisfies PluginDefinition;

  expect(openSearchStoreCandidates(plugin, candidates[0])).toEqual(candidates);
});

test("OpenSearch Store target 按 Plugin 顺序重试", async () => {
  const visited: string[] = [];
  const failures: string[] = [];
  const selected = await prepareFirstAvailableStore(
    candidates,
    async ({ service, store }) => {
      visited.push(`${service}/${store}`);
      if (service === "jaeger-collector") throw new Error("socket closed");
      return `${service}/${store}`;
    },
    ({ service, store }, reason) => failures.push(`${service}/${store}: ${reason}`),
  );

  expect(selected).toBe("kb-server/vdb");
  expect(visited).toEqual(["jaeger-collector/trace", "kb-server/vdb"]);
  expect(failures).toEqual(["jaeger-collector/trace: socket closed"]);
});

test("所有 OpenSearch Store target 失败时汇总原因", async () => {
  expect(prepareFirstAvailableStore(
    candidates,
    async ({ service }) => { throw new Error(`${service} unavailable`); },
    () => {},
  )).rejects.toThrow(
    "jaeger-collector/trace: jaeger-collector unavailable；kb-server/vdb: kb-server unavailable",
  );
});
