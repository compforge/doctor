import { expect, test } from "bun:test";
import { createServiceCatalog, describeService, type PluginDefinition, type ServiceDefinition, type ServiceInspect } from "@compforge/doctor-plugin";
import { describeServiceCommands } from "../src/app/service-commands";
import { formatServiceDescription } from "../src/app/plugin-description";
import { dataServicesForBizQuery } from "../src/collect/data/config";
import { tenantInspectServices } from "../src/collect/tenant/services";

const forbidden = () => { throw new Error("Offline discovery must not access configuration or targets"); };
const component = { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } };
function service(name: string, extra: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return { component, name, workloads: [], capabilities: {}, ...extra };
}
function inspect(accepts: string[], expands: string[] = []): ServiceInspect {
  return { access: {}, accepts, expands, provides: ["record"], description: "查询业务记录与运行现场",
    resolveTarget: async () => forbidden(), inspect: async () => forbidden() };
}
const plugin: PluginDefinition = {
  id: "sample", version: "1.0.0", validateConfig: forbidden,
  services: createServiceCatalog([
    service("lifecycle", {
      aliases: ["runtime-manager"],
      workloads: [{ name: "main", platform: "kubernetes", location: { kind: "service", name: "manager" } }],
      capabilities: { log: { default: true }, dataSources: [{ id: "db", kind: "db", backend: "mysql", envPrefix: "DB" }] },
      contributions: { inspect: inspect(["biz_id", "pod_name"], ["run_id"]) },
    }),
    service("run", { contributions: { inspect: inspect(["run_id"]) } }),
    service("tenant-only", { contributions: { inspect: inspect(["tenant_id"]) } }),
    service("unreachable", { contributions: { inspect: inspect(["message_id"]) } }),
    service("cache", { capabilities: { dataSources: [{ id: "cache", kind: "redis", backend: "redis", environment: { address: "REDIS_ADDRESS" } }] } }),
    service("empty"),
  ]),
};
const visible = new Set(["data", "db", "log", "inspect", "tenant"]);

test("business data and tenant discovery reuse the execution identity selectors", () => {
  const commands = describeServiceCommands(plugin, visible);
  const providers = (name: string) => [...commands].filter(([, values]) => values.some(value => value.name === name)).map(([name]) => name);
  expect(providers("data")).toEqual(dataServicesForBizQuery(plugin.services));
  expect(providers("data")).toEqual(["lifecycle", "run"]);
  expect(providers("tenant")).toEqual(tenantInspectServices(plugin.services).map(service => service.name));
  expect(commands.get("tenant-only")?.[0]?.missingRequirements).toContain("plugin.tenant");
  expect(commands.get("unreachable")).toEqual([]);
});

test("DB requires a database, logs need no trace resolver, workload inspection needs no Inspect contribution", () => {
  const commands = describeServiceCommands(plugin, visible);
  expect(commands.get("lifecycle")?.map(command => command.name)).toEqual(["db", "log", "data", "inspect"]);
  expect(commands.get("lifecycle")?.find(command => command.name === "log")?.missingRequirements).toEqual([]);
  expect(commands.get("cache")).toEqual([]);
  const workloadOnly = service("worker", { workloads: plugin.services.find("lifecycle")!.workloads });
  expect(describeServiceCommands({ ...plugin, services: createServiceCatalog([workloadOnly]) }, visible).get("worker")?.map(command => command.name)).toEqual(["inspect"]);
});

test("Distribution visibility hides names in both command projections and rendered details", () => {
  const commands = describeServiceCommands(plugin, new Set(["plugin", "data"]));
  const description = { ...describeService(plugin.services.find("runtime-manager")!), commands: commands.get("lifecycle")! };
  expect(description.commands.map(command => command.name)).toEqual(["data"]);
  const text = formatServiceDescription(description);
  expect(text).toContain("data：查询业务记录与运行现场");
  expect(text).not.toContain("db：");
  expect(text).not.toContain("log：");
  expect(text).toContain("未检查目标环境");
  expect(JSON.stringify(description)).not.toContain("envPrefix");
});

test("discovery is independent of catalog order and follows multiple relation hops", () => {
  const services = [...plugin.services.services, service("message", { contributions: { inspect: inspect(["message_id"]) } })];
  services[1] = service("run", { contributions: { inspect: inspect(["run_id"], ["message_id"]) } });
  const commands = describeServiceCommands({ ...plugin, services: createServiceCatalog(services.reverse()) }, visible);
  expect(commands.get("message")?.map(command => command.name)).toContain("data");
  expect(commands.get("empty")).toEqual([]);
});

test("default distribution does not advertise empty stores, tenant data in eval, or incomplete perf providers", () => {
  const services = [...plugin.services.services,
    service("empty-store", { capabilities: { dataSources: [] } }),
    service("perf-only", { capabilities: { perf: { scenarios: [] } } }),
  ];
  const commands = describeServiceCommands({ ...plugin, services: createServiceCatalog(services) });
  expect(commands.get("empty-store")).toEqual([]);
  expect(commands.get("perf-only")).toEqual([]);
  expect(commands.get("tenant-only")?.some(command => command.name === "eval")).toBe(false);
  expect(commands.get("lifecycle")?.find(command => command.name === "eval")?.missingRequirements).toContain("service.case");
});
