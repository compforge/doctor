import { expect, test } from "bun:test";
import { createServiceCatalog, type PluginDefinition } from "@compforge/doctor-plugin";
import {
  evaluatePluginCapabilities,
  type PluginCapabilityContract,
} from "../src/command/plugin-capability";

const plugin = {
  id: "sample",
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
