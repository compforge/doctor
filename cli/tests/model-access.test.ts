import { withSummary } from "@compforge/doctor-plugin";
import { caseExtension, catalogExtensions, directoryExtensions, inferenceExtensions, inspectExtension, perfExtension } from "../../packages/plugin/tests/extension-fixture";
import { expect, spyOn, test } from "bun:test";
import { validatePluginDefinition } from "../src/plugin/definition";
import { loadCaseCatalog, requireWorkloadProbeExtension, requireCaseRunnerCreateExtension, requireModelInvokeExtension, DOCTOR_PLUGIN_API_VERSION, type CaseCatalogExtension } from "@compforge/doctor-plugin";
import type { PluginManifest } from "../src/plugin/manifest";
import { openModelAccess, openModelDiscoveryAccess } from "../src/model";
import { KubectlExecutor } from "@compforge/harness-toolbox/kubernetes/executor";

const manifest: PluginManifest = {
  manifestVersion: 1,
  pluginApiVersion: DOCTOR_PLUGIN_API_VERSION,
  id: "test",
  version: "0.0.1",
  requiresDoctor: ">=0.1.0",
  contentDigest: `sha256:${"0".repeat(64)}`,
  main: "./plugin.mjs",
  skills: [],
};

test("Plugin Inspect contribution 必须提供 inspect", () => {
  const base = {
    access: {},
    accepts: ["biz_id"],
    provides: ["record"],
    resolveTarget: async () => ({}),
  };
  const definition = (inspect: Record<string, unknown>) => ({
    id: "test",
    version: "0.0.1",
    services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "records",
        workloads: [],
        extensions: [{ id: "inspect", kind: "facts.inspect", ...inspect }]
      }]
    },
  });

  expect(validatePluginDefinition(definition({ ...base, run: async () => ({}) }), manifest))
    .toBeDefined();
  expect(() => validatePluginDefinition(definition({ ...base, query: async () => ({}) }), manifest))
    .toThrow("run");
  expect(() => validatePluginDefinition(definition(base), manifest))
    .toThrow("run");
});

test("Plugin tenant capability 只绑定租户目录", () => {
  const valid = {
    id: "test",
    version: "0.0.1",
    tenant: { directoryService: "iam" },
    services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "iam",
        workloads: [],
        extensions: [...directoryExtensions({
          endpoint: { host: "test-service", port: 8080 },
          access: {},
          create: () => ({
            listActive: async () => [],
            getByName: async (name: string) => ({ id: name, name, displayName: name }),
          }),
        })]
      }]
    },
  };
  expect(() => validatePluginDefinition(valid, manifest)).toThrow("Unsupported Plugin bindings");
  const { tenant: _, ...native } = valid;
  expect(validatePluginDefinition(native, manifest).services.extensions("tenant.list")).toHaveLength(1);
});

test("Plugin model capability requires an endpoint on each declared provider", () => {
  const plugin = {
    id: "test",
    version: "0.0.1",
    services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "tenant-directory",
        workloads: [],
        extensions: [...directoryExtensions({
          endpoint: { host: "test-service", port: 8080 },
          access: {},
          create: () => ({
            listActive: async () => [],
            getByName: async (name: string) => ({ id: name, name, displayName: name }),
          }),
        })]
      }, {
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "model-catalog",
        workloads: [],
        extensions: [...catalogExtensions({
          endpoint: { host: "test-service", port: 8081 },
          access: {},
          create: () => ({
            query: async () => [],
            getBackend: async () => undefined,
          }),
        })]
      }, {
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "inference",
        workloads: [],
        extensions: [{ id: "invoke", kind: "model.invoke", access: {}, run: withSummary({"title":"模型调用","fields":[{"label":"HTTP 状态","path":["status"]}]}, async () => { throw new Error("must not run"); }) }]
      }]
    },
  };

  const validated = validatePluginDefinition(plugin, manifest);
  expect(() => requireModelInvokeExtension(validated.services.extensions("model.invoke")[0]!.extension)).toThrow("endpoint");
});

test("Plugin model capability supports discovery without inference", async () => {
  const plugin = {
    id: "test",
    version: "0.0.1",
    services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "tenant-directory",
        workloads: [],
        extensions: [...directoryExtensions({
          endpoint: { host: "test-service", port: 8080 },
          access: {},
          create: () => ({
            listActive: async () => [],
            getByName: async (name: string) => ({ id: name, name, displayName: name }),
          }),
        })]
      }, {
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "model-catalog",
        workloads: [],
        extensions: [...catalogExtensions({
          endpoint: { host: "test-service", port: 8081 },
          access: {},
          create: () => ({
            query: async () => [],
            getBackend: async () => undefined,
          }),
        })]
      }]
    },
  };

  const validated = validatePluginDefinition(plugin, manifest);
  expect(validated.services.extensions("model.query")).toHaveLength(1);
  expect(validated.services.extensions("model.invoke")).toHaveLength(0);
});

test("Plugin Toolchain 可省略，提供时必须满足公共协议", () => {
  const base = {
    id: "test",
    version: "0.0.1",
    services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "api",
        workloads: []
      }]
    },
  };
  expect(validatePluginDefinition(base, manifest).services.find("api")?.toolchain).toBeUndefined();

  expect(() => validatePluginDefinition({
    ...base,
    services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "api",
        workloads: [],
        toolchain: { language: "python", executionPlatform: "unknown" }
      }],
    },
  }, manifest)).toThrow("Plugin Service 'api'.toolchain is invalid");
});

test("Service probes 只接受 Core 支持的声明式共同 Probe", () => {
  const probe = {
    id: "apparmor-unconfined",
    kind: "kubernetes.apparmor-unconfined-admission",
    schemaVersion: 1,
    subject: "workload-service-account",
  } as const;
  const plugin = (candidate: Record<string, unknown>) => ({
    id: "test",
    version: "0.0.1",
    services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "runtime-api",
        workloads: [],
        environmentProbes: [candidate]
      }]
    },
  });

  expect(validatePluginDefinition(plugin(probe), manifest).services
    .find("runtime-api")?.environmentProbes)
    .toEqual([probe]);
  expect(() => validatePluginDefinition(plugin({ ...probe, kind: "custom.exec" }), manifest))
    .toThrow("uses unsupported kind 'custom.exec'");
  expect(() => validatePluginDefinition(plugin({ ...probe, subject: "fixed-service-account" }), manifest))
    .toThrow("uses unsupported subject 'fixed-service-account'");
  expect(() => validatePluginDefinition(plugin({ ...probe, schemaVersion: 2 }), manifest))
    .toThrow("uses unsupported schemaVersion '2'");
});

test("Service detector 必须有唯一 id 与纯 detect 入口", () => {
  const definition = (detectors: unknown) => ({
    id: "test",
    version: "0.0.1",
    services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "runtime-api",
        workloads: [],
        detectors: detectors
      }]
    },
  });
  const detector = { id: "runtime-health", detect: () => [] };

  expect(validatePluginDefinition(definition([detector]), manifest).services
    .find("runtime-api")?.detectors?.[0]?.id).toBe("runtime-health");
  expect(() => validatePluginDefinition(definition([
    detector,
    { ...detector },
  ]), manifest)).toThrow("runtime-api.detectors contains duplicate id 'runtime-health'");
  expect(() => validatePluginDefinition(definition([{
    id: "runtime-health",
  }]), manifest)).toThrow("runtime-api.detectors.runtime-health.detect must be a function");
});

test("Workload Probe 在执行前声明完整 Observation contract", () => {
  const definition = (produces: unknown) => ({
    id: "test",
    version: "0.0.1",
    services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "runtime-api",
        workloads: [{
          name: "main",
          platform: "kubernetes", location: { kind: "service", name: "runtime-api" },
        }],
        extensions: [{
          id: "health",
          kind: "workload.probe",

          access: {},
          workload: "main",
          produces,
          run: withSummary({ title: "Probe", fields: [] }, async () => ({})),
        }]
      }]
    },
  });

  const validated = validatePluginDefinition(definition({
    kind: "health",
    schemaVersion: 1,
    schema: {
      type: "object",
      properties: { ready: { type: "boolean" } },
      required: ["ready"],
      additionalProperties: false,
    },
  }), manifest).services.extensions("workload.probe")[0]!.extension;
  expect(validated.kind).toBe("workload.probe");
  expect(requireWorkloadProbeExtension(validated).produces.kind).toBe("health");
  expect(() => validatePluginDefinition(definition({ schemaVersion: 1 }), manifest))
    .toThrow("Observation");
  expect(() => validatePluginDefinition(definition({ kind: "health", schemaVersion: 0 }), manifest))
    .toThrow("Observation");
});

test("Plugin trace source 必须引用 Catalog 中已声明的 Store", () => {
  const base = {
    id: "test",
    version: "0.0.1",
    trace: { analysis: {} },
    services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "trace-store",
        workloads: [],
        dataSources: [{ id: "vdb", kind: "vdb", backend: "opensearch" }]
      }],
    },
  };

  expect(validatePluginDefinition({
    ...base,
    trace: {
      ...base.trace,
      source: { dataSource: { service: "trace-store", dataSource: "vdb" } },
    },
  }, manifest).trace?.source?.dataSource).toEqual({ service: "trace-store", dataSource: "vdb" });

  expect(() => validatePluginDefinition({
    ...base,
    trace: {
      ...base.trace,
      source: { dataSource: { service: "missing", dataSource: "vdb" } },
    },
  }, manifest)).toThrow("trace.source.dataSource references unknown Service 'missing'");

  expect(() => validatePluginDefinition({
    ...base,
    trace: {
      ...base.trace,
      source: { dataSource: { service: "trace-store", dataSource: "missing" } },
    },
  }, manifest)).toThrow("trace.source.dataSource references unknown Store 'trace-store/missing'");
});

test("Service capability dependency 必须引用另一 Service 已声明的 Store", () => {
  const dependency = {
    id: "trace-store",
    service: "kb-server",

    dataSource: "vdb",
  } as const;
  const base = {
    id: "test",
    version: "0.0.1",
    services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "kb-server",
        workloads: [],
        dataSources: [{ id: "vdb", kind: "vdb", backend: "opensearch" }]
      }, {
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "opensearch",
        workloads: [],
        dependencies: [dependency]
      }],
    },
  };

  expect(validatePluginDefinition(base, manifest).services.find("opensearch")?.dependencies)
    .toEqual([dependency]);

  expect(() => validatePluginDefinition({
    ...base,
    services: {
      services: [base.services.services[0], {
        ...base.services.services[1],
        dependencies: [{
          id: "trace-store",
          service: "kb-server",

          dataSource: "missing",
        }],
      }],
    },
  }, manifest)).toThrow("references unknown Store 'kb-server/missing'");

  expect(() => validatePluginDefinition({
    ...base,
    services: {
      services: [base.services.services[0], {
        ...base.services.services[1],
        dependencies: [
          dependency,
          dependency,
        ],
      }],
    },
  }, manifest)).toThrow("contains duplicate id 'trace-store'");

  expect(() => validatePluginDefinition({
    ...base,
    services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "kb-server",
        workloads: [],
        dataSources: [{ id: "database", kind: "db", backend: "mysql", envPrefix: "DB" }]
      }, {
        ...base.services.services[1],
        dependencies: [{ ...dependency, dataSource: "database" }],
      }],
    },
  }, manifest)).toThrow("当前只支持 OpenSearch VDB");
});

test("Plugin case catalog owns CaseSet validation independently of the runner", () => {
  const caseSet = {
    caseset: "chat", focus: "Chat Cases", schema_version: 1 as const,
    facets: { difficulty: { values: ["simple", "complex"], ordered: true } },
    cases: [{ id: "ordinary_chat", input: { query: "hello" }, facets: { difficulty: "simple" } }],
  };
  const catalog: CaseCatalogExtension = { id: "chat.cases", kind: "case.catalog", load: () => [caseSet] };
  const base = {
    id: "test",
    version: "0.0.1",
    extensions: [catalog],
    services: {
      services: [{
        component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
        name: "chat",
        workloads: [],
        extensions: [caseExtension({
          endpoint: { host: "test-service", port: 8000 },
          access: {},
          createRunner: async () => { throw new Error("factory must not run"); },
        }),
        perfExtension({
          scenarios: [{
            id: "ordinary-chat",
            title: "普通 Chat",
            description: "SSE Chat",
            observability: {
              metricServices: ["chat"],
              logServices: ["chat"],
              correlationKeys: ["message_id"],
            },
          }],
        })]
      }]
    },
  };
  const validated = validatePluginDefinition(base, manifest);
  expect(validated.services.extensions("perf.scenarios")).toHaveLength(1);
  expect(loadCaseCatalog(catalog)).toMatchObject([caseSet]);
  expect(() => loadCaseCatalog({ ...catalog, load: () => [{ ...caseSet, facets: undefined }] }))
    .toThrow("unknown facet 'difficulty'");
  expect(() => loadCaseCatalog({ ...catalog, load: () => [{
    ...caseSet, cases: [{ ...caseSet.cases[0]!, facets: { difficulty: "medium" } }],
  }] })).toThrow("facet difficulty='medium' not in declared values");

});

test("Plugin Case request identity references a tenant directory provider", () => {
  const caseService = {
    component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } },
    name: "chat",
    workloads: [],
    extensions: [caseExtension({
      endpoint: { host: "test-service", port: 8000 },
      access: {},
      requestIdentity: {
        configured: () => ({}),
      },
      createRunner: async () => { throw new Error("factory must not run"); },
    })]
  };
  const validated = validatePluginDefinition({
    id: "test", version: "0.0.1", services: { services: [caseService] },
  }, manifest);
  const runner = requireCaseRunnerCreateExtension(validated.services.extensions("case.runner.create")[0]!.extension);
  expect(runner.requestIdentity?.configured({})).toEqual({});
  expect(validated.services.extensions("tenant.list")).toHaveLength(0);

});


for (const requirement of [undefined, "preferred", "required"] as const) {
  test(`model discovery respects capability access: ${requirement ?? "none"}`, async () => {
    const checks: string[] = [];
    let created = 0;
    const run = spyOn(KubectlExecutor.prototype, "run").mockImplementation(async command => {
      let stdout: string;
      if (command[0] === "auth") {
        checks.push(command.slice(2).join(" "));
        stdout = "no";
      } else if (command[0] === "config") {
        stdout = "test-context\nhttps://cluster.test/";
      } else if (command[0] === "version" || command.join(" ") === "get --raw=/version") {
        stdout = '{"gitVersion":"v1.30.0"}';
      } else {
        throw new Error(`Unexpected Kubernetes call: ${command.join(" ")}`);
      }
      return {
        command, stdout, stderr: "", ok: stdout !== "no", exitCode: stdout === "no" ? 1 : 0,
        durationMs: 0, timedOut: false
      };
    });
    const access = requirement ? {
      kubernetes: [{
        rule: { verb: "create", resource: "pods/portforward" }, requirement, purpose: "访问目录",
      }]
    } : {};
    const service = { component: { name: "fixture", repository: { forge: { name: "test" }, path: "fixtures/app" } }, workloads: [] };
    const plugin = validatePluginDefinition({
      id: "test", version: "0.0.1",
      services: {
        services: [{
          ...service,
          name: "directory",
          extensions: [...directoryExtensions({
            endpoint: { host: "directory", port: 8080 }, access, create: () => {
              created++;
              return { listActive: async () => [], getByName: async name => ({ id: name, name, displayName: name }) };
            }
          })]
        }, {
          ...service,
          name: "catalog",
          extensions: [...catalogExtensions({
            endpoint: { host: "catalog", port: 8081 }, access, create: () => {
              created++;
              return { query: async () => [], getBackend: async () => undefined };
            }
          })]
        }]
      },
    }, manifest);
    try {
      const opening = openModelDiscoveryAccess({
        command: "doctor model", plugin,
        namespace: "test", context: "test-context", kubeconfig: "/tmp/model-access-test", interactive: false
      });
      const discovery = await opening;
      expect(created).toBe(0);
      try {
        if (requirement === "required") {
          await expect(discovery!.catalog.query({ identity: { kind: "tenant_id", value: "tenant" } })).rejects.toThrow("缺少必须的 Kubernetes 权限");
          expect(created).toBe(0);
        } else {
          expect(await discovery!.directory.listActive()).toEqual([]);
          expect(await discovery!.catalog.query({ identity: { kind: "tenant_id", value: "tenant" } })).toEqual([]);
          expect(created).toBe(2);
        }
      } finally { await discovery?.dispose(); }
      expect([...new Set(checks)].sort()).toEqual(requirement
        ? ["create pods/portforward", "list pods", "list services"] : []);
    } finally { run.mockRestore(); }
  });
}
