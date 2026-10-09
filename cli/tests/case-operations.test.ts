import { expect, mock, test } from "bun:test";
import { createServiceCatalog, withSummary, type CaseProducer, type ServiceCaseSource, type ServiceDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { CommandContext } from "../src/command";
import { caseCheckActions } from "../src/health/case-runtime";
import { createHostPluginContext } from "../src/plugin/context";
import { invokeOperation } from "../src/plugin/operation";

const service: ServiceDefinition = { name: "source", workloads: [],
  component: { name: "fixture", repository: { forge: { name: "test" }, path: "test" } } };

function executor(allowed: boolean, calls: string[][]): Executor {
  return {
    run: async command => {
      calls.push(command);
      const stdout = command[0] === "auth" ? allowed ? "yes" : "no"
        : command[0] === "config" ? "cluster\nhttps://cluster.test" : "{}";
      return { command, stdout, stderr: "", ok: true, exitCode: 0, durationMs: 1, timedOut: false };
    },
    exec: async () => { throw new Error("producer must not enter consumer Pods"); },
  };
}

test("Health native producer checks its own access before invocation and retains source attribution", async () => {
  const run = mock(withSummary({ title: "Requests", fields: [] }, async () => ({ cases: [], reason: "fixture" })));
  const source: ServiceCaseSource = { id: "files", load: () => [], produce: {
    access: { kubernetes: [{ rule: { verb: "get", resource: "services", resourceName: "source" },
      requirement: "required", purpose: "prepare file addresses" }] }, run,
  } };
  const context = new CommandContext({}, undefined, {
    plugin: { id: "test", version: "1", services: createServiceCatalog([{ ...service, cases: [source] }]) },
  });
  const calls: string[][] = [];
  try {
    const actions = caseCheckActions(context, executor(false, calls), { namespace: "ns" }, "/unused", () => {});
    await expect(actions.produce(service, source, { maxCases: 1 })).rejects.toThrow("Case files produce");
    expect(run).not.toHaveBeenCalled();
    expect(calls).toEqual([["auth", "can-i", "get", "services/source"]]);
  } finally { await context.disposeClients(); }
});

test("native producer contexts remain isolated and are disposed on success, failure and invalid output", async () => {
  for (const outcome of ["success", "failure", "invalid"] as const) {
    const disposed = mock(() => {});
    const run = mock(async (ctx: Parameters<CaseProducer["run"]>[0]) => {
      expect(ctx.target.service.name).toBe(service.name);
      ctx.onDispose(disposed);
      // The Service also contributes a more privileged source; it must not grant this one access.
      await expect(ctx.infra.kubernetes.get("secrets", "private")).rejects.toThrow("未声明");
      if (outcome === "failure") throw new Error("source unavailable");
      if (outcome === "invalid") return { data: { cases: [], reason: "fixture" } } as never;
      return { data: { cases: [], reason: "fixture" }, summary: { title: "Requests", fields: [] } };
    });
    const source: ServiceCaseSource = { id: "files", load: () => [], produce: { access: {}, run } };
    const privileged: ServiceCaseSource = { id: "admin", load: () => [], produce: {
      access: { kubernetes: [{ rule: { verb: "get", resource: "secrets" }, requirement: "required", purpose: "fixture" }] }, run,
    } };
    const context = new CommandContext({}, undefined, {
      plugin: { id: "test", version: "1", services: createServiceCatalog([{ ...service, cases: [source, privileged] }]) },
    });
    const calls: string[][] = [];
    try {
      const actions = caseCheckActions(context, executor(true, calls), { namespace: "ns" }, "/unused", () => {});
      const result = actions.produce(service, source, { maxCases: 1 });
      if (outcome === "success") expect(await result).toEqual({ cases: [], reason: "fixture" });
      else await expect(result).rejects.toThrow(outcome === "failure" ? "source unavailable" : "Summary");
      expect(run).toHaveBeenCalledTimes(1);
      expect(disposed).toHaveBeenCalledTimes(1);
      expect(calls.every(command => command[0] === "config")).toBe(true);
    } finally { await context.disposeClients(); }
    expect(disposed).toHaveBeenCalledTimes(1);
  }
});

test("ordinary native operations reject cancellation before and after invocation", async () => {
  for (const preCancelled of [true, false]) {
    const controller = new AbortController();
    const run = mock(withSummary({ title: "Requests", fields: [] }, async () => {
      controller.abort();
      return { cases: [], reason: "fixture" };
    }));
    const producer: CaseProducer = { access: {}, run };
    const context = createHostPluginContext({ service, capability: producer, signal: controller.signal });
    if (preCancelled) controller.abort();
    try {
      await expect(invokeOperation(producer, context, { maxCases: 1 })).rejects.toThrow();
      expect(run).toHaveBeenCalledTimes(preCancelled ? 0 : 1);
    } finally { await context.dispose(); }
  }
});
