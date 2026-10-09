import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kubernetesServiceWorkload, withSummary, type CaseProducer, type ServiceCaseSource,
  type CaseProduceResult, type ServiceDefinition, type WorkloadInstance } from "@compforge/doctor-plugin";
import { CommandContext } from "../src/command";
import type { ApprovalDecision, ApprovalRequest } from "../src/command/approval";
import { resolveApprovalGate } from "../src/terminal/approval";
import { createHealthCaseApproval } from "../src/health/approval";
import type { PreparedCaseCheck } from "../src/health/case-prepare";
import { checkServiceCases } from "../src/health/cases";

const component = { name: "fixture", repository: { forge: { name: "test" }, path: "test" } };
const producer: CaseProducer = { access: {},
  run: withSummary({ title: "Probes", fields: [] }, async () => ({ cases: [] })) };
const caseSource: ServiceCaseSource = { id: "probes", load: () => [], produce: producer };
const source: ServiceDefinition = { name: "models", component, workloads: [], cases: [caseSource] };
const post: CaseProduceResult["cases"][number] = {
  case: { id: "chat", input: { protocol: "http", method: "POST", body: "{}" },
    judge: { e2e: { http: { status: [200] } } } },
  targets: [{ id: "primary", url: "http://inference.test/chat?token=SECRET" }],
};
const read: CaseProduceResult["cases"][number] = {
  case: { id: "read", input: { protocol: "http", method: "GET" }, judge: { e2e: { http: { status: [200] } } } },
  targets: [{ id: "primary", url: "http://inference.test/read" }],
};
const target: WorkloadInstance = { platform: "kubernetes", environment: "test", namespace: "ns",
  pod: "worker-1", container: "app", workload: "main", uid: "uid-1" };

function prepared(name: string): PreparedCaseCheck {
  const consumer: ServiceDefinition = { name, component, workloads: [kubernetesServiceWorkload(name)] };
  const binding = { id: "model-check", workload: "main", producer: { service: source.name, source: caseSource.id } };
  return {
    result: { consumeExtension: "checks", bindingId: binding.id, consumer: name, workload: binding.workload,
      producer: binding.producer, startedAt: new Date().toISOString(), stage: "binding", status: "unavailable", targets: [], attempts: [] },
    execution: { consumer, binding, consumeIndex: 0, bindingIndex: 0, service: source, source: caseSource, query: { maxCases: 10 } },
  };
}

for (const approved of [true, false]) {
  test(`Health shares ${approved ? "approval" : "refusal"} across Services, replicas and Cases`, async () => {
    const context = new CommandContext({});
    const checks = [prepared("worker"), prepared("executor")];
    const requests: ApprovalRequest[] = [];
    const sent: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), "health-approval-"));
    try {
      for (const check of checks) {
        const approve = createHealthCaseApproval(context, "ns", checks, async request => {
          expect(sent).toEqual([]);
          requests.push(request);
          return { approved, source: "prompt" };
        });
        const [result] = await checkServiceCases([check], {
          directory, signal: context.signal, checkpoint: () => {}, approve,
          targets: async () => ({ targets: [target, { ...target, pod: "worker-2", uid: "uid-2" }] }),
          sender: async () => async request => {
            sent.push(request.method);
            return { statusCode: 200, statusText: "OK", headers: {}, body: new Response("ok").body };
          },
          produce: async () => ({ cases: [post, { ...post, case: { ...post.case, id: "embedding" } }, read,
            { ...read, case: { ...read.case, id: "head", input: { protocol: "http", method: "HEAD" } } }] }),
        });
        expect(result!.status).toBe(approved ? "passed" : "cancelled");
        expect(result!.attempts).toHaveLength(approved ? 8 : 4);
      }
      expect(requests).toHaveLength(1);
      expect(requests[0]!.title).toBe("执行本轮 Health 的非只读 Case 检查");
      expect(requests[0]!.target).toBe("ns: worker/main, executor/main");
      expect(requests[0]!.impact).toContain("worker/main → models/probes");
      expect(requests[0]!.impact).toContain("executor/main → models/probes");
      expect(requests[0]!.impact.some(line => line.includes("10 个 Running 实例"))).toBe(true);
      expect(JSON.stringify(requests)).not.toContain("SECRET");
      expect(sent.filter(method => method === "POST")).toHaveLength(approved ? 8 : 0);
      expect(sent.filter(method => method === "GET" || method === "HEAD")).toHaveLength(8);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test("GET/HEAD-only Health does not ask for approval", async () => {
  const context = new CommandContext({});
  const checks = [prepared("worker")];
  const directory = mkdtempSync(join(tmpdir(), "health-read-"));
  let asked = 0;
  try {
    const results = await checkServiceCases(checks, {
      directory, signal: context.signal, checkpoint: () => {},
      approve: createHealthCaseApproval(context, "ns", checks, async () => {
        asked++;
        return { approved: false, source: "prompt" };
      }),
      targets: async () => ({ targets: [target] }),
      sender: async () => async () => ({ statusCode: 200, statusText: "OK", headers: {}, body: new Response("ok").body }),
      produce: async () => ({ cases: [read, { ...read, case: { ...read.case, id: "head", input: { protocol: "http", method: "HEAD" } } }] }),
    });
    expect(asked).toBe(0);
    expect(results[0]!.status).toBe("passed");
    expect(results[0]!.attempts).toHaveLength(2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("changed Health scope and a new CommandContext ask again", async () => {
  const context = new CommandContext({});
  const checks = [prepared("worker")];
  let asked = 0;
  const gate = async (): Promise<ApprovalDecision> => { asked++; return { approved: true, source: "prompt" }; };
  await createHealthCaseApproval(context, "ns", checks, gate)(target, post);
  await createHealthCaseApproval(context, "ns", checks, gate)(target, post);
  expect(asked).toBe(1);
  await createHealthCaseApproval(context, "ns", [...checks, prepared("executor")], gate)(target, post);
  expect(asked).toBe(2);
  await createHealthCaseApproval(new CommandContext({}), "ns", checks, gate)(target, post);
  expect(asked).toBe(3);
});

test("Health preserves assume-yes and non-interactive refusal decisions", async () => {
  const checks = [prepared("worker")];
  const context = new CommandContext({}, undefined, { yes: true });
  expect(await createHealthCaseApproval(context, "ns", checks, resolveApprovalGate(context.options))(target, post))
    .toEqual({ approved: true, source: "assume-yes" });
  let asked = 0;
  const approve = createHealthCaseApproval(new CommandContext({}), "ns", checks, async () => {
    asked++;
    return { approved: false, source: "non-interactive" };
  });
  expect(await approve(target, post)).toEqual({ approved: false, source: "non-interactive" });
  expect(await approve({ ...target, uid: "uid-2" }, post)).toEqual({ approved: false, source: "non-interactive" });
  expect(asked).toBe(1);
});
