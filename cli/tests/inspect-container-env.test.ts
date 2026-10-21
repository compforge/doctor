import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { CommandContext } from "../src/command";
import { KubernetesAccessContext } from "../src/infra/k8s/access";
import { EvidenceBundle } from "../src/collect/evidence";
import { collectedFact, unavailableFact } from "../src/collect/protocol";
import { buildInspectCoverage, buildInspectEvidence, searchInspectFields } from "../src/collect/inspect/detector";
import { containerEnvironmentTargets } from "../src/collect/inspect/fact/inspect";
import { makeContainerEnvironmentProbe, parseContainerEnvironment } from "../src/collect/inspect/probe/container-environment";
import type { InspectCommandContext, InspectFacts, InspectPodRuntimeFact } from "../src/collect/inspect/model";

const response = (stdout: string): ExecResult => ({ ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false, command: ["kubectl", "exec"] });
const pod = (name: string): InspectPodRuntimeFact => ({
  instance: { platform: "kubernetes", environment: "test", workload: "api", namespace: "demo", uid: name, pod: name },
  pod: name, environmentContainer: "main", serviceAccountName: "default", phase: "Running", conditions: [],
  containers: [{ name: "main", image: "same-image:v1", requests: {}, limits: {}, restartCount: 0 }],
});
function facts(pods: InspectPodRuntimeFact[]): InspectFacts {
  return {
    serviceTargets: collectedFact("inspect.service-targets", "service-targets", { services: { api: {
      service: "api", workloads: { api: { name: "api", location: { kind: "labels", labels: { app: "api" } },
        probes: [], deployments: [], unavailableDeployments: [], podRuntime: collectedFact("inspect.workload-pods", "service-targets", { pods }) } },
    } } }),
    deploymentConfiguration: unavailableFact("inspect.deployment-configuration", "service-targets", "not requested"),
    dependencyTargets: unavailableFact("inspect.dependency-targets", "service-targets", "not requested"),
    lifecycleSignals: unavailableFact("inspect.lifecycle-signals", "service-targets", "not requested"),
  };
}

test("Pod Env parser preserves multiline, empty values and embedded equals without accepting malformed or oversized output", () => {
  expect(parseContainerEnvironment("IMAGE_ENV=present\0MULTILINE=line1\nline2=a=b\0EMPTY=\0")).toEqual({
    IMAGE_ENV: "present", MULTILINE: "line1\nline2=a=b", EMPTY: "",
  });
  expect(parseContainerEnvironment("")).toEqual({});
  expect(() => parseContainerEnvironment("K=v\n")).toThrow("NUL");
  expect(() => parseContainerEnvironment("invalid\0")).toThrow("无效条目");
  expect(() => parseContainerEnvironment("K=" + "x".repeat(1024 * 1024) + "\0")).toThrow("1 MiB");
});

test("Pod Env covers replicas independently and records stopped or ambiguous containers as gaps", () => {
  const stopped = { ...pod("stopped"), phase: "Pending" };
  const ambiguous = { ...pod("ambiguous"), environmentContainer: undefined, environmentUnavailableReason: "multiple containers" };
  const result = containerEnvironmentTargets(facts([pod("api-0"), pod("api-1"), stopped, ambiguous]));
  expect(result.targets.map(target => target.pod)).toEqual(["api-0", "api-1"]);
  expect(result.missing.join("\n")).toContain("Pending");
  expect(result.missing.join("\n")).toContain("multiple containers");
});

for (const failure of [undefined, "denied", "timeout", "missing-command", "malformed"] as const) {
  test(`Pod Env observation and coverage retain actual values or failure: ${failure ?? "success"}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "inspect-pod-env-"));
    const command = new CommandContext({});
    let execCalls = 0;
    const executor: Executor = {
      run: async () => response("no"),
      exec: async (target, args, options) => {
        execCalls++;
        expect(args).toEqual(["printenv", "-0"]);
        expect(options?.timeoutMs).toBe(15_000);
        if (target.pod === "api-1" && failure) {
          if (failure === "malformed") return response("TRUNCATED=value");
          return { ...response(""), ok: false, exitCode: 1, timedOut: failure === "timeout", stderr: "printenv not found" };
        }
        return response(`SANDBOX=${target.pod}\0IMAGE_ENV=image-default\0INJECTED_SECRET=resolved-value\0`);
      },
    };
    const authorization = new KubernetesAccessContext(executor);
    const bundle = new EvidenceBundle(root);
    const ctx: InspectCommandContext = {
      command, executor, authorization, bundle, log: () => {},
      config: { namespace: "demo", namespaceSource: "flag", services: ["api"], servicesExplicit: true,
        field: "env", format: "bundle", reportName: "fixture", profileName: "test", kube: { namespace: "demo" } },
    };
    try {
      if (failure === "denied") await authorization.evaluate({ command: "doctor inspect", needs: [{
        requirement: "preferred", rule: { verb: "create", resource: "pods/exec" }, purpose: "Pod Env",
      }] });
      const input = facts([pod("api-0"), pod("api-1")]);
      const observations = [];
      for (const target of containerEnvironmentTargets(input).targets) {
        const probe = makeContainerEnvironmentProbe(target);
        observations.push(...await probe.run(ctx, input, ctx.config, []));
      }
      const evidence = buildInspectEvidence(observations, input);
      const search = searchInspectFields(evidence, "env", "sandbox");
      const coverage = buildInspectCoverage(evidence, { field: "env" }).find(item => item.goal === "container-environment")!;
      if (failure === "denied") {
        expect(execCalls).toBe(0);
        expect(coverage.status).toBe("insufficient");
        expect(coverage.missingEvidence.join("\n")).toContain("pods/exec");
        expect(search.matches).toEqual([]);
      } else {
        expect(execCalls).toBe(2);
        expect(search.matches).toHaveLength(failure ? 1 : 2);
        expect(searchInspectFields(evidence, "env", "image-default").matches).toHaveLength(failure ? 1 : 2);
        expect(coverage.status).toBe(failure ? "partial" : "sufficient");
        if (failure) expect(coverage.missingEvidence.join("\n")).toContain(failure === "timeout" ? "超时"
          : failure === "malformed" ? "NUL" : "printenv not found");
      }
    } finally {
      await command.disposeClients();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
