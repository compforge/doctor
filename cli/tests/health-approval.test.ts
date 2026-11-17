import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kubernetesServiceWorkload, withSummary, type CaseProducer, type ServiceCaseSource,
  type CaseProduceResult, type ServiceDefinition, type WorkloadInstance } from "@compforge/doctor-plugin";
import { CommandContext } from "../src/command";
import type { ApprovalDecision, ApprovalRequest } from "../src/command/approval";
import { resolveApprovalGate } from "../src/terminal/approval";
import { createHealthCaseApproval } from "../src/health/cases/approval";
import type { PreparedCaseCheck } from "../src/health/cases/prepare";
import { checkServiceCases } from "../src/health/cases/run";

const component = { name: "fixture", repository: { forge: { name: "test" }, path: "test" } };
const producer: CaseProducer = { access: {},
  run: withSummary({ title: "Probes", fields: [] }, async () => ({ cases: [] })) };
const caseSource: ServiceCaseSource = { id: "probes", load: () => [], produce: producer };
const source: ServiceDefinition = { name: "models", component, workloads: [], cases: [caseSource] };
const post: CaseProduceResult["cases"][number] = {
  case: { id: "chat", desc: "验证模型能够响应基础问答", input: { protocol: "http", method: "POST", body: "{}" },
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
    execution: { consumer, binding, bindingIndex: 0, service: source, source: caseSource, query: { maxCases: 10 } },
  };
}

for (const approved of [true, false]) {
  test(`Health decides each Case and instance independently; approved=${approved}`, async () => {
    const context = new CommandContext({});
    const requests: ApprovalRequest[] = [];
    const sent: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), "health-approval-"));
    const approve = createHealthCaseApproval(context, "ns", async request => {
      requests.push(request); return { approved, source: "prompt" };
    });
    try {
      for (const check of [prepared("worker"), prepared("executor")]) {
        const [result] = await checkServiceCases([check], {
          directory, signal: context.signal, checkpoint: () => {}, approve,
          targets: async () => ({ targets: [target, { ...target, pod: "worker-2", uid: "uid-2" }] }),
          sender: async () => async request => {
            sent.push(request.method);
            return { statusCode: 200, statusText: "OK", headers: {}, body: new Response("ok").body };
          }, produce: async () => ({ cases: [post, read] }),
        });
        expect(result!.status).toBe(approved ? "passed" : "skipped");
        expect(result!.attempts).toHaveLength(approved ? 4 : 0);
      }
      expect(requests).toHaveLength(8);
      expect(requests.filter(request => request.risk === "observe")).toHaveLength(4);
      expect(requests[0]!.target).toContain("worker / ns/worker-1/app");
      expect(requests[0]!.purpose).toBe("验证模型能够响应基础问答");
      expect(requests[1]!.purpose).toBeUndefined();
      expect(JSON.stringify(requests)).not.toContain("SECRET");
      expect(sent).toHaveLength(approved ? 8 : 0);
    } finally { rmSync(directory, { recursive: true, force: true }); await context.disposeClients(); }
  });
}

test("refusing one Case still runs the next Case", async () => {
  const context = new CommandContext({});
  const directory = mkdtempSync(join(tmpdir(), "health-skip-"));
  const sent: string[] = [];
  try {
    const [result] = await checkServiceCases([prepared("worker")], {
      directory, signal: context.signal, checkpoint: () => {},
      approve: createHealthCaseApproval(context, "ns", async request => ({ approved: request.risk === "observe", source: "prompt" })),
      targets: async () => ({ targets: [target] }),
      sender: async () => async request => { sent.push(request.method); return { statusCode: 200, statusText: "OK", headers: {}, body: new Response("ok").body }; },
      produce: async () => ({ cases: [post, read] }),
    });
    expect(sent).toEqual(["GET"]);
    expect(result!.status).toBe("skipped");
    expect(result!.error).toContain("用户跳过");
  } finally { rmSync(directory, { recursive: true, force: true }); await context.disposeClients(); }
});

test("identical decisions reuse within one command, but another consumer or instance asks again", async () => {
  const context = new CommandContext({});
  const next = new CommandContext({});
  let asked = 0;
  const gate = async (): Promise<ApprovalDecision> => { asked++; return { approved: false, source: "prompt" }; };
  const approve = createHealthCaseApproval(context, "ns", gate);
  try {
    await approve(target, post, prepared("worker").result);
    await approve(target, post, prepared("worker").result);
    expect(asked).toBe(1);
    await approve(target, post, prepared("executor").result);
    await approve({ ...target, uid: "new-instance" }, post, prepared("worker").result);
    await createHealthCaseApproval(next, "ns", gate)(target, post);
    expect(asked).toBe(4);
  } finally { await context.disposeClients(); await next.disposeClients(); }
});

test("Health preserves assume-yes and noninteractive refusal", async () => {
  const context = new CommandContext({}, undefined, { yes: true });
  try {
    expect(await createHealthCaseApproval(context, "ns", resolveApprovalGate(context.options))(target, post))
      .toEqual({ approved: true, source: "assume-yes" });
  } finally { await context.disposeClients(); }
});
