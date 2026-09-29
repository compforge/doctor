import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentSource } from "@compforge/doctor-agent";
import { PatchEmitter } from "@compforge/agentue/ui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ChatHistoryStore, exportChat, historyBlocks, validateSessionFlags } from "../src/chat/history";
import { createDoctorModel } from "../src/chat/model";
import { Session } from "../src/chat/session";
import { Controller } from "../src/chat/controller";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "doctor-chat-history-"));
  roots.push(root);
  return { root, store: new ChatHistoryStore(root, join(root, "sessions")) };
}
const identity = { profile: "test", plugin: "example@1" };
const user: AgentMessage = { role: "user", content: "diagnose", timestamp: 1 };
const assistant = (content: string): AgentMessage => ({ role: "assistant", content: [{ type: "text", text: content }],
  api: "openai-completions", provider: "openai", model: "test", stopReason: "stop", timestamp: 2,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

function sse(text: string): Response {
  const chunk = { id: "test", object: "chat.completion.chunk", created: 0, model: "test" };
  return new Response([
    `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]", "",
  ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
}

async function turn(agent: Agent, text: string) {
  for await (const _event of agent.run(text, { emitter: new PatchEmitter() })) { /* consume */ }
}

test("Pi JSONL persists completed messages and resumes them in the next model request", async () => {
  const { root, store } = fixture();
  const history = (await store.prepare({}, identity))!;
  const agent = new Agent({
    llm: { provider: "openai", model: "test", apiKey: "secret-not-persisted", fetch: async () => sse("first answer") },
    env: new NodeExecutionEnv({ cwd: root }),
    onMessage: async (message) => { await history.session.appendMessage(message); },
  });
  await turn(agent, "first question");
  // Already on disk before Agent disposal.
  expect(readFileSync(history.metadata.path, "utf8")).toContain("first answer");
  expect(readFileSync(history.metadata.path, "utf8")).not.toContain("secret-not-persisted");
  expect(statSync(history.metadata.path).mode & 0o777).toBe(0o600);
  await agent.dispose();

  const reopened = (await store.prepare({ continue: true }, identity))!;
  expect(reopened.metadata.id).toBe(history.metadata.id);
  expect(reopened.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  let request: unknown;
  const next = new Agent({
    llm: { provider: "openai", model: "test", apiKey: "secret", fetch: async (_input, init) => {
      request = JSON.parse(String(init?.body)); return sse("second answer");
    } },
    env: new NodeExecutionEnv({ cwd: root }), messages: reopened.messages,
    onMessage: async (message) => { await reopened.session.appendMessage(message); },
  });
  await turn(next, "second question");
  await next.dispose();
  expect(JSON.stringify(request)).toContain("first question");
  expect(JSON.stringify(request)).toContain("first answer");
  expect((await store.prepare({ session: history.metadata.path }, identity))!.messages).toHaveLength(4);
  expect((await store.prepare({}, identity))!.metadata.id).not.toBe(history.metadata.id);
});

test("session selection is scoped, ephemeral mode does not create files, plugin changes reject restore", async () => {
  const { root, store } = fixture();
  expect(await store.prepare({ noSession: true }, identity)).toBeUndefined();
  expect(existsSync(join(root, "sessions"))).toBe(false);
  const history = (await store.prepare({ continue: true }, identity))!;
  const again = await store.prepare({ session: history.metadata.id }, identity);
  expect(again?.metadata.id).toBe(history.metadata.id);
  await expect(store.prepare({ session: history.metadata.id }, { ...identity, plugin: "example@2" })).rejects.toThrow("Plugin");
  await expect(store.prepare({ session: history.metadata.id }, { ...identity, profile: "prod" })).rejects.toThrow("profile");
  const elsewhere = new ChatHistoryStore(join(root, "elsewhere"), join(root, "sessions"));
  expect(await elsewhere.list()).toEqual([]);
  await expect(elsewhere.prepare({ session: history.metadata.path }, identity)).rejects.toThrow("工作目录");
  expect(() => validateSessionFlags({ noSession: true, resume: true })).toThrow("--no-session");
  expect(() => validateSessionFlags({ server: true, continue: true })).toThrow("--server");
  expect(() => validateSessionFlags({ continue: true, session: "id" })).toThrow("只能指定一个");
});

test("tool content survives JSONL export and HTML escapes model/tool text", async () => {
  const { root, store } = fixture();
  const history = (await store.prepare({}, identity))!;
  const toolCall = assistant("checking");
  if (toolCall.role !== "assistant") throw new Error("fixture");
  toolCall.content.push({ type: "toolCall", id: "call-1", name: "read", arguments: { path: "input.txt" } });
  const toolResult: AgentMessage = { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false,
    timestamp: 3, content: [{ type: "text", text: `<script>alert(1)</script>${"x".repeat(70_000)}` }] };
  for (const message of [user, toolCall, toolResult]) await history.session.appendMessage(message);
  const path = await exportChat(history, join(root, "export.jsonl"));
  expect(readFileSync(path, "utf8")).toBe(readFileSync(history.metadata.path, "utf8"));
  const reopened = (await store.prepare({ session: path }, identity))!;
  expect(reopened.messages).toHaveLength(3);
  expect(historyBlocks(reopened.messages).at(-1)).toMatchObject({ type: "tool", status: "completed", args: { path: "input.txt" } });
  const html = readFileSync(await exportChat(history, join(root, "export.html")), "utf8");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("x".repeat(70_000));
  await expect(exportChat(history, path)).rejects.toThrow();
});

test("persistence errors end the turn visibly and prevent unrecorded follow-up turns", async () => {
  const { root } = fixture();
  const agent = new Agent({
    llm: { provider: "openai", model: "test", apiKey: "secret", fetch: async () => sse("answer") },
    env: new NodeExecutionEnv({ cwd: root }), onMessage: async () => { throw new Error("disk full"); },
  });
  await expect(turn(agent, "question")).rejects.toThrow("保存聊天失败");
  await expect(turn(agent, "again")).rejects.toThrow("保存聊天失败");
  await agent.dispose();
});

test("slash commands inspect, export and select sessions without invoking the agent", async () => {
  const { root, store } = fixture();
  const history = (await store.prepare({}, identity))!;
  await history.session.appendMessage(user);
  const source: AgentSource = { async *run() { throw new Error("must not prompt"); }, abort() {}, async dispose() {} };
  const session = new Session(createDoctorModel({ profileName: "test", profile: { readonly: true }, mode: "local", warnings: [] }), source, undefined, history, store);
  let selected: string | undefined;
  const controller = new Controller(session, () => {}, (request) => { selected = request.session; });
  await controller.command("session");
  expect(controller.stateStore.getState("footer").toast?.text).toContain(history.metadata.path);
  await controller.command("export", join(root, "slash.jsonl"));
  expect(existsSync(join(root, "slash.jsonl"))).toBe(true);
  await controller.command("resume");
  expect(controller.stateStore.getState("composer").picker?.options).toHaveLength(1);
  controller.resolvePicker("resume", history.metadata.path);
  expect(selected).toBe(history.metadata.path);
  await controller.dispose();
});
