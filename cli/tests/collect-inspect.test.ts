import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServiceCatalog,
  type PluginDefinition,
  type ServiceEvidenceFact,
} from "@compforge/doctor-plugin";
import { examplePlugin } from "../../plugins/example/src";
import {
  makeInspectDetectors,
  projectInspectServiceFacts,
  resolveInspectDeploymentSelection,
  resolveInspectDependencySelection,
  runCollectInspect,
  type InspectConfig,
  type InspectEvidence,
  type InspectFacts,
} from "../src/collect/inspect";
import type { ExecResult, Executor } from "../src/infra/k8s/executor";
import { inspectContainerStateFact } from "../src/collect/inspect/fact/inspect";
import { CommandContext } from "../src/command";
import { deliverCommandArtifacts } from "../src/app/delivery";

function result(stdout = ""): ExecResult {
  return {
    ok: true,
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    command: ["kubectl"],
  };
}

const createCommandContext = () => new CommandContext({});

async function runInspectWithDelivery(
  opts: Parameters<typeof runCollectInspect>[0],
  plugin: PluginDefinition,
  executor: Executor,
): Promise<number> {
  const context = createCommandContext();
  const code = await runCollectInspect(opts, plugin, context, executor);
  expect(await deliverCommandArtifacts(context, opts, code, "doctor inspect")).toBe(true);
  return code;
}

function detectorEvidence(): InspectEvidence {
  return {
    facts: {
      serviceTargets: { status: "unavailable", reason: "not needed by detector test" },
      deploymentConfiguration: { status: "unavailable", reason: "not requested" },
      dependencyTargets: { status: "unavailable", reason: "not requested" },
    },
    rows: [],
    observations: [{
      id: "environment-probe-sandbox-server-apparmor-sandbox",
      kind: "kubernetes-apparmor-unconfined-admission",
      service: "sandbox-server",
      probe: "apparmor-unconfined",
      namespace: "demo",
      serviceAccountName: "sandbox-server",
      status: "allowed",
    }, {
      id: "plugin-workload-bedbox-main-health-bedbox-0",
      kind: "plugin-workload",
      observationKind: "hostel-health",
      observationSchemaVersion: 1,
      service: "bedbox",
      workload: "main",
      namespace: "demo",
      pod: "bedbox-0",
      probe: "health",
      value: { suite: false },
    }],
  };
}

test("Service Evidence detector 可关联跨 Service Observation", () => {
  const catalog = createServiceCatalog([{
    name: "sandbox-server",
    workloads: [],
    capabilities: {},
  }, {
    name: "bedbox",
    workloads: [],
    contributions: {
      detectors: [{
        id: "suite-isolation",
        detect: (evidence) => {
        const appArmor = evidence.observations.find((item) => (
          item.services.includes("sandbox-server")
          && item.kind === "kubernetes-apparmor-unconfined-admission"
        ));
        const health = evidence.observations.find((item) => (
          item.services.includes("bedbox")
          && item.kind === "plugin/agentsphere/bedbox/hostel-health"
          && item.schemaVersion === 1
        ));
        return appArmor && health ? [{
          id: "suite-disabled",
          kind: "suite-disabled",
          schemaVersion: 1,
          severity: "warning",
          confidence: "high",
          message: "AppArmor admission 已放开，但 Bedbox 尚未启用 suite isolation",
          evidence: [
            { observationId: appArmor.id, role: "context" },
            { observationId: health.id, role: "supporting" },
          ],
        }] : [];
        },
      }],
    },
    capabilities: {},
  }]);

  const findings = makeInspectDetectors("agentsphere", catalog, ["sandbox-server", "bedbox"])
    .flatMap((detector) => detector(detectorEvidence()));

  expect(findings).toEqual([expect.objectContaining({
    id: "service-detector:bedbox:suite-isolation:suite-disabled",
    service: "bedbox",
    detector: "suite-isolation",
    kind: "plugin/agentsphere/bedbox/suite-disabled",
    schemaVersion: 1,
    producer: {
      origin: "plugin",
      plugin: "agentsphere",
      service: "bedbox",
      id: "suite-isolation",
    },
    evidence: [
      { observationId: "environment-probe-sandbox-server-apparmor-sandbox", role: "context" },
      { observationId: "plugin-workload-bedbox-main-health-bedbox-0", role: "supporting" },
    ],
  })]);
});

test("Service Evidence detector 不能引用本次 Evidence 之外的对象", () => {
  const catalog = createServiceCatalog([{
    name: "bedbox",
    workloads: [],
    contributions: {
      detectors: [{
        id: "invalid-reference",
        detect: () => [{
        id: "invalid",
        kind: "invalid",
        schemaVersion: 1,
        severity: "critical",
        confidence: "high",
        message: "invalid evidence reference",
        evidence: [{ observationId: "missing", role: "supporting" }],
        }],
      }],
    },
    capabilities: {},
  }]);

  expect(() => makeInspectDetectors("agentsphere", catalog, ["bedbox"])[0]!(detectorEvidence()))
    .toThrow("references unknown Observation 'missing'");
});

test("Service Probe Fact 投影不按 Service 过滤 Core Inspect Facts", () => {
  const facts: InspectFacts = {
    serviceTargets: {
      status: "collected",
      services: Object.fromEntries(["api", "worker"].map((service) => [service, {
        service,
        configurationSupported: false,
        workloads: {},
      }])),
    },
    deploymentConfiguration: { status: "unavailable", reason: "not requested" },
    dependencyTargets: { status: "unavailable", reason: "not requested" },
  };

  const projected = projectInspectServiceFacts(facts, ["api", "worker"]);

  expect(projected.filter((fact) => fact.kind === "service-target").map((fact) => fact.services))
    .toEqual([["api"], ["worker"]]);
  expect(projected).toContainEqual(expect.objectContaining({
    kind: "service-targets",
    schemaVersion: 1,
    services: ["api", "worker"],
    producer: { origin: "core", id: "service-targets" },
  }));
});

test("terminated state 只投影 Inspect Fact 声明的字段", () => {
  const state = inspectContainerStateFact({
    kind: "terminated",
    reason: "OOMKilled",
    exitCode: 137,
    containerId: "containerd://runtime-only",
  });

  expect(state).toMatchObject({ kind: "terminated", reason: "OOMKilled", exitCode: 137 });
  expect(state).not.toHaveProperty("containerId");
});

test("Deployment Env/ConfigMap 仅在 flag 或交互确认后采集", async () => {
  const config: InspectConfig = {
    namespace: "demo",
    namespaceSource: "default",
    services: ["example-api"],
    servicesExplicit: true,
    includeDeploymentConfig: false,
    includeDependencies: false,
    format: "html",
    reportName: "doctor-inspect-test",
    profileName: "default",
    kube: { namespace: "demo" },
  };
  expect(await resolveInspectDeploymentSelection({ config, interactive: false })).toBe(false);
  expect(await resolveInspectDeploymentSelection({
    config,
    interactive: true,
    prompt: async () => true,
  })).toBe(true);
  expect(await resolveInspectDeploymentSelection({
    config: { ...config, includeDeploymentConfig: true },
    interactive: false,
  })).toBe(true);
  expect(await resolveInspectDependencySelection({ config, interactive: false })).toBe(false);
  expect(await resolveInspectDependencySelection({
    config,
    interactive: true,
    prompt: async () => true,
  })).toBe(true);
  expect(await resolveInspectDependencySelection({
    config: { ...config, includeDependencies: true },
    interactive: false,
  })).toBe(true);
});

test("inspect 分别交付 workload、可选 Service 配置和 partial Coverage", async () => {
  let workloadProbeFacts: readonly ServiceEvidenceFact[] | undefined;
  const pluginWithEnvironmentProbes = {
    ...examplePlugin,
    services: createServiceCatalog(examplePlugin.services.services.map((service) => (
      service.name === "example-api"
        ? {
            ...service,
            contributions: {
              probes: [{
                id: "apparmor-unconfined",
                kind: "kubernetes.apparmor-unconfined-admission",
                schemaVersion: 1,
                subject: "workload-service-account",
              }, {
                id: "core-facts",
                kind: "workload",
                schemaVersion: 1,
                access: {},
                workload: "main",
                observation: { kind: "core-facts-visible", schemaVersion: 1 },
                probe: async (_context, input) => {
                  workloadProbeFacts = input.facts;
                  return { value: { pod: input.instance.pod } };
                },
              }],
            },
          }
        : service
    ))),
  } satisfies PluginDefinition;
  const resources = {
    services: JSON.stringify({ items: [{
      metadata: { name: "example-api", namespace: "demo" },
      spec: { selector: { app: "example-api" }, ports: [{ port: 8080, targetPort: 8080 }] },
    }] }),
    deployments: JSON.stringify({ items: [{
      metadata: { name: "example-api" },
      spec: { template: { metadata: { labels: { app: "example-api" } }, spec: { containers: [{
        name: "example-api",
        ports: [{ containerPort: 8080 }],
        envFrom: [{ configMapRef: { name: "example-api" } }],
        env: [{ name: "LOG_LEVEL", value: "debug" }],
      }] } } },
    }] }),
    configmaps: JSON.stringify({ items: [{
      metadata: { name: "example-api" },
      data: { REQUEST_TIMEOUT: "30" },
    }] }),
    pods: JSON.stringify({ items: [{
      metadata: { namespace: "demo", name: "example-api-0", labels: { app: "example-api" } },
      spec: { serviceAccountName: "example-api", containers: [{
        name: "example-api",
        image: "example.test/example-api:v1.2.3",
        resources: {
          requests: { cpu: "250m", memory: "256Mi" },
          limits: { cpu: "1", memory: "1Gi" },
        },
      }] },
      status: {
        phase: "Running",
        conditions: [{
          type: "Ready",
          status: "False",
          reason: "ContainersNotReady",
          message: "containers with unready status: [example-api]",
        }],
        containerStatuses: [{
          name: "example-api",
          imageID: "example.test/example-api@sha256:1234",
          ready: false,
          restartCount: 12,
          state: {
            waiting: {
              reason: "CrashLoopBackOff",
              message: "back-off restarting failed container example-api",
            },
          },
          lastState: { terminated: {
            containerID: "containerd://previous",
            exitCode: 137,
            reason: "OOMKilled",
            finishedAt: "2026-08-19T02:00:00Z",
          } },
        }],
      },
    }] }),
  };
  const queriedResources: string[] = [];
  const dependencyCommands: string[][] = [];
  let admissionCalls = 0;
  let admissionUnavailable = false;
  const executor: Executor = {
    run: async (args) => {
      if (args[0] === "create" && args.includes("--dry-run=server")) {
        admissionCalls += 1;
        if (admissionUnavailable) throw new Error("impersonation unavailable");
        return result("{}");
      }
      const resource = args[1];
      if (resource) queriedResources.push(resource);
      if (resource && resource in resources) return result(resources[resource as keyof typeof resources]);
      throw new Error(`unexpected kubectl: ${args.join(" ")}`);
    },
    exec: async (_target, command) => {
      dependencyCommands.push(command);
      return result(JSON.stringify({
        runtimeVersion: "v22.0.0",
        dependencies: [{ name: "zod", version: "4.4.3" }],
      }));
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "doctor-inspect-test-"));
  try {
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, "");
    const completeOutput = join(dir, "complete.md");
    expect(await runInspectWithDelivery({
      namespace: "demo",
      services: "example-api",
      deploymentConfig: true,
      config: configPath,
      format: "md",
      output: completeOutput,
    }, pluginWithEnvironmentProbes, executor)).toBe(0);
    const complete = readFileSync(completeOutput, "utf-8");
    expect(complete).toContain("Deployment Env/ConfigMap：已采集");
    expect(complete).toContain("example.test/example-api:v1.2.3");
    expect(complete).toContain("250m");
    expect(complete).toContain("Ready=False: ContainersNotReady");
    expect(complete).toContain("restarts=12");
    expect(complete).toContain("waiting: CrashLoopBackOff");
    expect(complete).toContain("last=terminated: OOMKilled, exit=137");
    expect(complete).toContain("REQUEST_TIMEOUT");
    expect(complete).toContain("AppArmor Unconfined：1 个 ServiceAccount 允许");
    expect(complete).toContain("| example-api | demo | example-api | allowed | — |");
    expect(complete).toContain("environment-config：sufficient");
    expect(complete).toContain("workload-runtime：sufficient");
    expect(workloadProbeFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "service-target",
        schemaVersion: 1,
        services: ["example-api"],
        producer: { origin: "core", id: "service-targets" },
      }),
      expect.objectContaining({
        kind: "deployment-configuration",
        schemaVersion: 1,
      }),
    ]));
    expect(Object.isFrozen(workloadProbeFacts)).toBe(true);
    expect(workloadProbeFacts?.every((fact) => Object.isFrozen(fact))).toBe(true);
    expect(Object.isFrozen(workloadProbeFacts?.find((fact) => fact.kind === "service-target")?.value)).toBe(true);

    const defaultOutput = join(dir, "default.tar.gz");
    expect(await runInspectWithDelivery({
      namespace: "demo",
      services: "example-api",
      deploymentConfig: true,
      config: configPath,
      output: defaultOutput,
    }, pluginWithEnvironmentProbes, executor)).toBe(0);
    expect(existsSync(join(dir, "default.html"))).toBe(true);
    expect(existsSync(defaultOutput)).toBe(true);

    queriedResources.length = 0;
    admissionUnavailable = true;
    const partialOutput = join(dir, "partial.md");
    expect(await runInspectWithDelivery({
      namespace: "demo",
      services: "example-api",
      config: configPath,
      format: "md",
      output: partialOutput,
    }, pluginWithEnvironmentProbes, executor)).toBe(0);
    expect(queriedResources).not.toContain("deployments");
    expect(queriedResources).not.toContain("configmaps");
    const partial = readFileSync(partialOutput, "utf-8");
    expect(partial).toContain("Deployment Env/ConfigMap：未采集");
    expect(partial).toContain("environment-config：insufficient");
    expect(partial).toContain("workload-runtime：sufficient");
    expect(partial).toContain("用户未确认采集 Deployment Env/ConfigMap");
    expect(partial).toContain("AppArmor Unconfined：未探测到（best effort）");
    admissionUnavailable = false;

    const dependenciesOutput = join(dir, "dependencies.md");
    expect(await runInspectWithDelivery({
      namespace: "demo",
      services: "example-api",
      dependencies: true,
      config: configPath,
      format: "md",
      output: dependenciesOutput,
    }, pluginWithEnvironmentProbes, executor)).toBe(0);
    expect(dependencyCommands).toHaveLength(1);
    expect(dependencyCommands[0]?.slice(0, 2)).toEqual(["node", "-e"]);
    const dependencies = readFileSync(dependenciesOutput, "utf-8");
    expect(dependencies).toContain("typescript");
    expect(dependencies).toContain("| Service | Runtime version | Dependency | Version |");
    expect(dependencies).not.toContain("| Service | Image | Runtime version");
    expect(dependencies).not.toContain("example.test/example-api@sha256:1234");
    expect(dependencies).toContain("example.test/example-api:v1.2.3");
    expect(dependencies).toContain("v22.0.0");
    expect(dependencies).toContain("zod");
    expect(dependencies).toContain("4.4.3");
    expect(dependencies).toContain("runtime-dependencies：sufficient");

    const pluginWithoutToolchain = {
      ...examplePlugin,
      services: createServiceCatalog([{
        name: "example-api",
        workloads: examplePlugin.services.find("example-api")!.workloads,
        capabilities: {
          log: { default: true },
        },
      }]),
    } satisfies PluginDefinition;
    const unavailableOutput = join(dir, "dependencies-without-toolchain.md");
    const commandsBeforeUnavailable = dependencyCommands.length;
    expect(await runInspectWithDelivery({
      namespace: "demo",
      services: "example-api",
      dependencies: true,
      config: configPath,
      format: "md",
      output: unavailableOutput,
    }, pluginWithoutToolchain, executor)).toBe(0);
    expect(dependencyCommands).toHaveLength(commandsBeforeUnavailable);
    const unavailable = readFileSync(unavailableOutput, "utf-8");
    expect(unavailable).toContain("Plugin 未声明 Toolchain");
    expect(unavailable).toContain("未声明");
    expect(unavailable).toContain("runtime-dependencies：insufficient");
    expect(admissionCalls).toBe(4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
