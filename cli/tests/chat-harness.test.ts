import { createModelAccess } from "../../packages/agent/src/model";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@compforge/doctor-agent";
import { BACKGROUND_CONTEXT as ctx, AgentHarness, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { PatchEmitter } from "@compforge/agentue/ui";
import { ChatHistoryStore, exportChat } from "../src/chat/history";
import { parseContextWindow } from "../src/app/bootstrap";

const roots: string[] = [];
const stores: ChatHistoryStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "doctor-harness-")); roots.push(root);
  const store = new ChatHistoryStore(root, join(root, "sessions")); stores.push(store);
  return { root, store };
}
const identity = { profile: "test", plugin: "none" };
function answer(text: string, tokens = 20) {
  const chunk = { id: "test", object: "chat.completion.chunk", created: 0, model: "test" };
  return new Response([
    `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: tokens, completion_tokens: 5, total_tokens: tokens + 5 } })}`,
    "data: [DONE]", "",
  ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
}
async function consume(events: AsyncIterable<unknown>) {
  const output = []; for await (const event of events) output.push(event); return JSON.stringify(output);
}
const context = () => ({ emitter: new PatchEmitter() });
const compaction = { enabled: true, reserveTokens: 512, keepRecentTokens: 64 };

test("Harness automatically compacts at the model threshold and restores compacted context with complete exports", async () => {
  const { root, store } = fixture();
  const history = (await store.prepare({}, identity))!;
  let count = 0;
  const agent = await Agent.create({ session: history.session, env: new NodeExecutionEnv({ cwd: root }), compaction,
    llm: { provider: "openai", model: "test", apiKey: "secret", contextWindow: 4096, maxTokens: 512,
      fetch: async () => { count++; return count === 1 ? answer("old answer")
        : count === 2 ? answer("next answer", 3800) : answer("SUMMARY_OLD_EVIDENCE"); } } });
  const oldPrompt = `OLD_DETAIL_${"x".repeat(1600)}`;
  await consume(agent.run(oldPrompt, context()));
  const events = await consume(agent.run("next question " + "y".repeat(400), context()));
  expect(events).toContain("threshold");
  expect(events).toContain("上下文压缩完成");
  expect(count).toBe(3);
  expect(await history.session.findEntries({ type: "compaction" }, ctx)).toHaveLength(1);
  const html = await exportChat(history, join(root, "full.html"));
  expect(readFileSync(html, "utf8")).toContain(oldPrompt);
  expect(readFileSync(history.metadata.path, "utf8")).toContain(oldPrompt);
  await agent.dispose();

  const reopened = (await store.prepare({ continue: true }, identity))!;
  expect(JSON.stringify(reopened.messages)).toContain(oldPrompt);
  let request = "";
  const next = await Agent.create({ session: reopened.session, env: new NodeExecutionEnv({ cwd: root }), compaction,
    llm: { provider: "openai", model: "test", apiKey: "secret", contextWindow: 4096, maxTokens: 512,
      fetch: async (_input, init) => { request = String(init?.body); return answer(request.includes("context summarization assistant") ? "SUMMARY_OLD_EVIDENCE" : "resumed"); } } });
  await consume(next.run("continue", context()));
  expect(request).toContain("SUMMARY_OLD_EVIDENCE");
  expect(request).not.toContain(oldPrompt);
  const sourceCompactions = await reopened.session.findEntries({ type: "compaction" }, ctx);
  await next.dispose();
  const sourceBytes = readFileSync(history.metadata.path, "utf8");
  const fork = (await store.prepare({ fork: history.metadata.path }, identity))!;
  expect(await fork.session.findEntries({ type: "compaction" }, ctx)).toEqual(sourceCompactions);
  let forkRequest = "";
  const forked = await Agent.create({ session: fork.session, env: new NodeExecutionEnv({ cwd: root }), compaction,
    llm: { provider: "openai", model: "test", apiKey: "secret", contextWindow: 4096, maxTokens: 512,
      fetch: async (_input, init) => { forkRequest = String(init?.body); return answer("forked"); } } });
  await consume(forked.run("continue on fork", context()));
  expect(forkRequest).toContain("SUMMARY_OLD_EVIDENCE");
  expect(forkRequest).not.toContain(oldPrompt);
  expect(readFileSync(await exportChat(fork, join(root, "fork.html")), "utf8")).toContain(oldPrompt);
  await forked.dispose();
  expect(readFileSync(history.metadata.path, "utf8")).toBe(sourceBytes);
});

test("Harness recovers context overflow by summarizing then retrying the interrupted turn", async () => {
  const { root, store } = fixture();
  const history = (await store.prepare({}, identity))!;
  let count = 0;
  const agent = await Agent.create({ session: history.session, env: new NodeExecutionEnv({ cwd: root }), compaction,
    llm: { provider: "openai", model: "test", apiKey: "secret", contextWindow: 4096, maxTokens: 512,
      fetch: async () => {
        count++;
        if (count === 2) return Response.json({ error: { message: "maximum context length exceeded", code: "context_length_exceeded" } }, { status: 400 });
        return answer(count === 1 ? "first answer" : count === 3 ? "OVERFLOW_SUMMARY" : "RECOVERED");
      } } });
  await consume(agent.run("long evidence " + "x".repeat(1600), context()));
  const events = await consume(agent.run("next", context()));
  expect(events).toContain("overflow");
  expect(events).toContain("RECOVERED");
  expect(events).not.toContain('"code":"llm_error"');
  expect(count).toBe(4);
  expect(await history.session.findEntries({ type: "compaction" }, ctx)).toHaveLength(1);
  await agent.dispose();
});

test("manual compaction preserves the transcript and uses the host model transport", async () => {
  const { root, store } = fixture();
  const history = (await store.prepare({}, identity))!;
  let calls = 0;
  const agent = await Agent.create({ session: history.session, env: new NodeExecutionEnv({ cwd: root }),
    llm: { provider: "openai", model: "test", apiKey: "secret", fetch: async () => answer(++calls === 1 ? "answer" : "MANUAL_SUMMARY") } });
  await consume(agent.run("question", context()));
  expect(await consume(agent.compact("keep the diagnosis", context()))).toContain("上下文压缩完成");
  expect(await history.session.findEntries({ type: "message" }, ctx)).toHaveLength(2);
  expect(await history.session.findEntries({ type: "compaction" }, ctx)).toHaveLength(1);
  await agent.dispose();
});

test("storage failure faults the Harness and prevents subsequent model calls", async () => {
  const { root } = fixture();
  const fileSystem = new NodeExecutionEnv({ cwd: root });
  const repo = new JsonlSessionRepo({ fileSystem, sessionsRoot: join(root, "fault-sessions") });
  const session = await repo.create({ cwd: root }, ctx);
  let calls = 0;
  const agent = await Agent.create({ session, env: new NodeExecutionEnv({ cwd: root }),
    llm: { provider: "openai", model: "test", apiKey: "secret", fetch: async () => { calls++; return answer("answer"); } } });
  const commit = spyOn(fileSystem, "appendFile").mockRejectedValue(new Error("disk full"));
  await expect(consume(agent.run("question", context()))).rejects.toThrow();
  commit.mockRestore();
  await expect(consume(agent.run("again", context()))).rejects.toThrow();
  expect(calls).toBe(0);
  await agent.dispose().catch(() => undefined);
  await repo.close(ctx);
  await fileSystem.cleanup(ctx);
});

test("configured context limits are validated and catalog K/M windows are interpreted", async () => {
  expect(parseContextWindow("128K")).toBe(128000);
  expect(parseContextWindow("1M")).toBe(1000000);
  expect(parseContextWindow("32768")).toBe(32768);
  expect(parseContextWindow("unknown")).toBeUndefined();
  const { root } = fixture();
  await expect(Agent.create({ env: new NodeExecutionEnv({ cwd: root }),
    llm: { provider: "openai", model: "test", apiKey: "secret", contextWindow: 100, maxTokens: 200 } })).rejects.toThrow("max_tokens");
});

test("restoring an interrupted durable operation aborts it without replay before accepting a new prompt", async () => {
  const { root, store } = fixture();
  const history = (await store.prepare({}, identity))!;
  let calls = 0;
  const llm = { provider: "openai" as const, model: "test", apiKey: "secret",
    fetch: async () => { calls++; return answer("new answer"); } };
  const access = createModelAccess(llm);
  const { harness } = await AgentHarness.create({ session: history.session, ...access }, ctx);
  const lane = await harness.lane("main", ctx);
  expect((await lane.accept({ kind: "prompt", prompt: "abandoned task" }, ctx)).ok).toBe(true);
  // Closing storage without driving simulates a process that disappeared after admission.
  await harness.close(ctx);
  const restored = (await store.prepare({ continue: true }, identity))!;
  const agent = await Agent.create({ session: restored.session, llm, env: new NodeExecutionEnv({ cwd: root }) });
  expect(agent.recoveredInterruptedRun).toBe(true);
  expect(calls).toBe(0);
  expect(await consume(agent.run("new question", context()))).toContain("new answer");
  expect(calls).toBe(1);
  await agent.dispose();
});

test("manual compaction can be aborted and the next turn remains usable", async () => {
  const { root, store } = fixture();
  const history = (await store.prepare({}, identity))!;
  let calls = 0;
  let started!: () => void;
  const summaryStarted = new Promise<void>((resolve) => { started = resolve; });
  const agent = await Agent.create({ session: history.session, env: new NodeExecutionEnv({ cwd: root }),
    llm: { provider: "openai", model: "test", apiKey: "secret", fetch: async (_input, init) => {
      calls++;
      if (calls !== 2) return answer("answer");
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    } } });
  await consume(agent.run("question", context()));
  const compacting = consume(agent.compact(undefined, context()));
  await summaryStarted;
  agent.abort();
  expect(await compacting).toContain("已中断");
  expect(await history.session.findEntries({ type: "compaction" }, ctx)).toHaveLength(0);
  expect(await consume(agent.run("continue", context()))).toContain("answer");
  await agent.dispose();
});
