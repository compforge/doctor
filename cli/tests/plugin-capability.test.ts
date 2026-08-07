import { expect, test } from "bun:test";
import {
  createServiceCatalog,
  type PluginContext,
  type PluginDefinition,
} from "@compforge/doctor-plugin";
import {
  evaluatePluginCapabilities,
  type PluginCapabilityContract,
} from "../src/command/plugin-capability";
import { PLUGIN_COMMAND_CAPABILITIES } from "../src/app/plugin-command-capabilities";
import { resolvePluginTraceId } from "../src/plugin/trace-id";

const plugin = {
  id: "sample",
  version: "0.0.1",
  services: createServiceCatalog([{
    name: "sample-api",
    capabilities: { log: { default: true } },
  }]),
} satisfies PluginDefinition;

test("Plugin command 没有当前 Plugin 时不可运行", () => {
  const evaluation = evaluatePluginCapabilities(undefined, {
    command: "doctor config",
    needs: [],
  });

  expect(evaluation.runnable).toBe(false);
});

test("required Plugin capability 缺失时阻止命令并保留 provider", () => {
  const contract: PluginCapabilityContract = {
    command: "doctor data",
    needs: [{
      requirement: "required",
      capability: { scope: "service", name: "log" },
      purpose: "选择日志 Service",
    }, {
      requirement: "required",
      capability: { scope: "service", name: "data" },
      purpose: "读取业务数据",
    }],
  };

  const evaluation = evaluatePluginCapabilities(plugin, contract);

  expect(evaluation.runnable).toBe(false);
  expect(evaluation.facts[0]).toMatchObject({ available: true, providers: ["sample-api"] });
  expect(evaluation.facts[1]).toMatchObject({ available: false, providers: [] });
});

test("preferred Plugin capability 缺失时允许命令降级", () => {
  const evaluation = evaluatePluginCapabilities(plugin, {
    command: "doctor config",
    needs: [{
      requirement: "preferred",
      capability: { scope: "plugin", name: "tenantConfiguration" },
      purpose: "补充租户配置",
      fallback: "只交付部署配置",
    }],
  });

  expect(evaluation.runnable).toBe(true);
  expect(evaluation.facts[0]?.available).toBe(false);
});

test("model command 不依赖租户配置采集能力", () => {
  expect(PLUGIN_COMMAND_CAPABILITIES.model.needs.map((need) => need.capability)).toEqual([
    { scope: "plugin", name: "model" },
    { scope: "service", name: "tenantDirectory" },
    { scope: "service", name: "modelCatalog" },
    { scope: "service", name: "inference" },
  ]);
});

test("traceId capability 以 Service provider 为单位发现", () => {
  const tracePlugin = {
    id: "trace-sample",
    version: "0.0.1",
    services: createServiceCatalog([{
      name: "trace-api",
      capabilities: {
        traceId: {
          endpoint: { port: 8080 },
          access: {},
          resolve: async () => ({ traceId: "trace-1", resolvedAs: "request_id" }),
        },
      },
    }]),
  } satisfies PluginDefinition;
  const evaluation = evaluatePluginCapabilities(tracePlugin, {
    command: "doctor trace",
    needs: [{
      requirement: "required",
      capability: { scope: "service", name: "traceId" },
      purpose: "解析 trace_id",
    }],
  });

  expect(evaluation.runnable).toBe(true);
  expect(evaluation.facts[0]).toMatchObject({ available: true, providers: ["trace-api"] });
});

test("traceId resolver 按 Catalog 顺序尝试 provider，返回实际命中的 Service", async () => {
  const tracePlugin = {
    id: "trace-sample",
    version: "0.0.1",
    services: createServiceCatalog([{
      name: "first-api",
      capabilities: {
        traceId: { endpoint: { port: 8080 }, access: {}, resolve: async () => undefined },
      },
    }, {
      name: "trace-api",
      capabilities: {
        traceId: {
          endpoint: { port: 8080 },
          access: {},
          resolve: async (context: PluginContext, { bizId }: { bizId: string }) => {
            expect(context).toMatchObject({
              target: {
                env: "test",
                namespace: "default",
                service: { name: "trace-api" },
              },
            });
            expect(context.infra.kubernetes).toBeDefined();
            expect(context.infra.databaseIdentity).toBeUndefined();
            context.onDispose(() => { throw new Error("cleanup failed"); });
            return { traceId: `trace-${bizId}`, resolvedAs: "request_id" };
          },
        },
      },
    }]),
  } satisfies PluginDefinition;

  expect(await resolvePluginTraceId({
    bizId: "biz-1",
    namespace: "default",
    kubeconfig: "/tmp/test-kubeconfig",
    context: "test-context",
    profileName: "test",
    command: "doctor trace",
  }, tracePlugin, {
    run: async () => { throw new Error("Core traceId resolver should not access Kubernetes"); },
    exec: async () => { throw new Error("Core traceId resolver should not access Kubernetes"); },
  })).toEqual({
    bizId: "biz-1",
    traceId: "trace-biz-1",
    service: "trace-api",
    resolvedAs: "request_id",
  });
});
