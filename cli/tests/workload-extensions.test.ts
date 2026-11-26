import { expect, mock, test } from "bun:test";
import { createServiceCatalog, DoctorError, defineInspectProbeExtension, defineObservation, defineWorkloadProbeExtension, type ServiceDefinition } from "@compforge/doctor-plugin";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RequestWorkloadsExtension } from "@compforge/doctor-plugin";
import { CommandContext, CommandStatus } from "../src/command";
import { runCollectInspect } from "../src/collect/inspect";
import type { StepRecord } from "../src/collect/evidence";
import { logPlugin, podDiscoveryExecutor } from "./log-fixture";
import { workloadProbeProviders } from "../src/plugin/workload-extensions";
class HealthValue {
  constructor(readonly ready: boolean) {}
  summary() { return { title: "Health", fields: [] }; }
}
const produces = defineObservation({ kind: "health", schemaVersion: 1, codec: {
  encode: (value: HealthValue) => ({ ready: value.ready }),
  decode: (json: unknown) => {
    if (!json || typeof json !== "object" || !("ready" in json) || typeof json.ready !== "boolean") throw new Error("invalid health");
    return new HealthValue(json.ready);
  },
} });
const service: ServiceDefinition = {
  name: "app",
  aliases: ["api"],
  component: { name: "test", repository: { forge: { name: "test" }, path: "test" } },
  workloads: [{ name: "main", platform: "kubernetes", location: { kind: "service", name: "app" } }]
};
const extension = defineWorkloadProbeExtension({ id: "health", kind: "workload.probe", workload: "main", produces, access: {}, run: async () => ({ value: new HealthValue(true), status: "ok" as const }) });

test("workload discovery preserves separate probe permissions without calling providers", () => {
  const run = mock(extension.run);
  const access = { kubernetes: [{ rule: { verb: "get", resource: "pods" }, requirement: "required", purpose: "inspect pod" }] } as const;
  const catalog = createServiceCatalog([{ ...service, extensions: [{ ...extension, run }, { ...extension, id: "details", access }] }]);
  const selected = workloadProbeProviders(catalog, "api");
  expect(selected.map(item => item.extension.id)).toEqual(["health", "details"]);
  expect(selected[0]!.extension.access).toEqual({});
  expect(selected[1]!.extension.access).toBe(access);
  expect(run).not.toHaveBeenCalled();
  expect(workloadProbeProviders(catalog, "missing")).toEqual([]);
});

test("workload references and Observation codecs are checked before scheduling", () => {
  const unknown = createServiceCatalog([{ ...service, extensions: [{ ...extension, workload: "missing" }] }]);
  expect(() => workloadProbeProviders(unknown)).toThrow("unknown Workload");
  const invalid = createServiceCatalog([{ ...service, extensions: [{ ...extension, produces: { ...produces, codec: { encode: produces.codec.encode } } }] }]);
  expect(() => workloadProbeProviders(invalid)).toThrow();
});

// @case inspect-request-workload-scope: only a selected declaration creates a Workload Probe requirement.
test.each(["empty", "unreadable", "image-denied", "broken", "mixed", "cancelled", "cancelled-pods"] as const)("Inspect preserves %s request Workload evidence", async bizId => {
  const controller = new AbortController();
  const selected = bizId === "unreadable" || bizId === "image-denied";
  const lookup: RequestWorkloadsExtension = {
    id: "targets", kind: "request.workloads", access: {},
    run: async () => {
      if (bizId === "broken") throw new DoctorError("association lookup failed", { code: "timeout" });
      return { data: bizId === "cancelled-pods" ? [{ name: "main", platform: "kubernetes",
        location: { kind: "labels", labels: { app: "worker" } } }] : !selected ? [] : [{ name: "main", platform: "kubernetes",
        location: { kind: "resource", resource_kind: "Pod", name: "chosen" } }],
        summary: { title: "Request targets", fields: [] } };
    },
  };
  const failedLookup: RequestWorkloadsExtension = { ...lookup, id: "secondary",
    run: async () => { throw new Error("secondary lookup failed"); } };
  const serviceProbe = defineInspectProbeExtension({ id: "service-health", kind: "inspect.probe", produces, access: {},
    run: async () => {
      if (bizId === "cancelled") controller.abort();
      return { status: "ok", value: new HealthValue(true) };
    } });
  const workloadProbe = { ...extension, run: async (...args: Parameters<typeof extension.run>) => {
    if (bizId === "cancelled-pods" && args[1].instance.pod === "pod-b") controller.abort();
    return extension.run(...args);
  } };
  const plugin = logPlugin({ ...service, extensions: [lookup, workloadProbe, serviceProbe, ...(bizId === "cancelled" ? [{ ...serviceProbe, id: "next" }] : []), ...(bizId === "mixed" ? [failedLookup] : [])] });
  const context = new CommandContext({}, undefined, { plugin, signal: controller.signal });
  const discovery = podDiscoveryExecutor([]);
  const reads: string[][] = [];
  try {
    const outcome = await runCollectInspect({ namespace: "test", services: ["app"], bizId, field: bizId === "image-denied" ? "image" : undefined }, plugin, context, {
      ...discovery,
      run: async args => {
        if (args[0] === "config") return discovery.run(args);
        const ok = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, command: args };
        if (args[0] === "auth") return { ...ok, stdout: "yes" };
        reads.push([...args]);
        if (args[1] === "pods" && bizId === "cancelled-pods") return { ...ok, stdout: JSON.stringify({
          items: ["pod-a", "pod-b", "pod-c"].map(name => ({
            metadata: { name, uid: name, namespace: "test", labels: { app: "worker" } },
            spec: { containers: [{ name: "app" }] }, status: { phase: "Running" },
          })),
        }) };
        if (args[1] === "pods") return { ...ok, ok: false, exitCode: 1, stderr: "Error from server (Forbidden): cannot get pod chosen" };
        return { ...ok, stdout: JSON.stringify({ items: [] }) };
      },
    });
    const bundle = context.artifacts.list()[0]!.path;
    const { steps, evidence }: { steps: StepRecord[]; evidence: string } = JSON.parse(readFileSync(join(bundle, "collection.json"), "utf8"));
    const probe = steps.find(step => step.id === "plugin-workload-app-main-health");
    if (bizId === "cancelled-pods") {
      expect(outcome.status).toBe(CommandStatus.Cancelled);
      expect(evidence).toBe("partial");
      expect(steps.filter(step => step.id.startsWith("plugin-workload-app-main-health-")).map(step => [step.status, step.reason_code]))
        .toEqual([["ok", undefined], ["unavailable", "cancelled"], ["skipped", "cancelled"]]);
      const diagnosis = JSON.parse(readFileSync(join(bundle, "diagnosis.json"), "utf8"));
      expect(diagnosis.evidence.observations.map((item: { id: string }) => item.id)).toContain("plugin-workload-app-main-health-pod-a");
      return;
    }
    if (bizId === "cancelled") {
      expect(outcome.status).toBe(CommandStatus.Cancelled);
      expect(evidence).toBe("partial");
      expect(steps.find(step => step.id === "plugin-inspect-app-next")).toMatchObject({
        status: "skipped", evidence: "missing", reason_code: "cancelled",
      });
      return;
    }
    if (bizId === "broken") {
      expect(evidence).toBe("missing");
      expect(outcome).toMatchObject({ status: CommandStatus.Failed, reason: expect.stringContaining("association lookup failed") });
      expect(steps).toEqual([expect.objectContaining({ status: "failed", reason_code: "timeout", reason: expect.stringContaining("association lookup failed") })]);
      expect(reads).toEqual([]);
      return;
    }
    if (selected) {
      const get = steps.find(step => step.request?.name === "chosen");
      expect(get).toMatchObject({ reason_code: "forbidden", source_code: 403 });
      expect(get?.reason).toContain("Forbidden");
      const { serviceTargets } = JSON.parse(readFileSync(join(bundle, "raw/facts.json"), "utf8"));
      expect(serviceTargets.services.app.workloads.main.podRuntime).toMatchObject({
        status: "unavailable", reasonCode: "forbidden", sourceCode: 403,
      });
    }
    if (bizId === "image-denied") {
      expect(outcome.status).toBe(CommandStatus.Failed);
      expect(evidence).toBe("missing");
      return;
    }
    expect(steps.find(step => step.id === "plugin-inspect-app-service-health")?.status).toBe("ok");
    const selection = steps.find(step => step.id === "request-workloads-app/targets")!;
    expect(selection.status).toBe("ok");
    expect(JSON.parse(readFileSync(join(bundle, selection.raw_file!), "utf8"))).toEqual({
      bizId, provider: "app/targets", workloads: bizId === "unreadable" ? [{ name: "main", service: "app" }] : [],
    });
    if (bizId !== "unreadable") {
      expect(evidence).toBe(bizId === "mixed" ? "partial" : "complete");
      expect(outcome.status).toBe(bizId === "mixed" ? CommandStatus.Partial : CommandStatus.Ok);
      if (bizId === "mixed") expect(steps.some(step => step.status === "failed" && step.reason?.includes("secondary lookup failed"))).toBe(true);
      expect(probe).toBeUndefined();
      expect(reads.some(args => args[1] === "pods")).toBe(false);
    } else {
      expect(outcome.status).toBe(CommandStatus.Partial);
      expect(probe?.status).toBe("unavailable");
      expect(probe?.reason).toContain("Forbidden");
    }
  } finally {
    await context.disposeClients();
    for (const artifact of context.artifacts.list()) rmSync(artifact.path, { recursive: true, force: true });
  }
});
