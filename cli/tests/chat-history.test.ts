import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentSource } from "@compforge/doctor-agent";
import { PatchEmitter } from "@compforge/agentue/ui";
import { BACKGROUND_CONTEXT, type AgentMessage } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ChatHistoryStore, exportChat, historyBlocks, validateSessionFlags } from "../src/chat/history";
import { createDoctorModel } from "../src/chat/model";
import { Session } from "../src/chat/session";
import { Controller } from "../src/chat/controller";

const ctx = BACKGROUND_CONTEXT;
const roots: string[] = [];
const stores: ChatHistoryStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "doctor-chat-history-"));
  roots.push(root);
  const store = new ChatHistoryStore(root, join(root, "sessions"));
  stores.push(store);
  return { root, store };
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
  const agent = await Agent.create({
    llm: { provider: "openai", model: "test", apiKey: "secret-not-persisted", fetch: async () => sse("first answer") },
    env: new NodeExecutionEnv({ cwd: root }),
    session: history.session,
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
  const next = await Agent.create({
    llm: { provider: "openai", model: "test", apiKey: "secret", fetch: async (_input, init) => {
      request = JSON.parse(String(init?.body)); return sse("second answer");
    } },
    env: new NodeExecutionEnv({ cwd: root }), session: reopened.session,
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
  await history.session.close(ctx);
  const again = await store.prepare({ session: history.metadata.id }, identity);
  expect(again?.metadata.id).toBe(history.metadata.id);
  await expect(store.prepare({ session: history.metadata.id }, { ...identity, plugin: "example@2" })).rejects.toThrow("Plugin");
  await expect(store.prepare({ session: history.metadata.id }, { ...identity, profile: "prod" })).rejects.toThrow("profile");
  const elsewhere = new ChatHistoryStore(join(root, "elsewhere"), join(root, "sessions"));
  stores.push(elsewhere);
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
  const branch = await history.session.createBranch("main", null, ctx);
  for (const message of [user, toolCall, toolResult]) await branch.appendMessage(message, ctx);
  const path = await exportChat(history, join(root, "export.jsonl"));
  expect(readFileSync(path, "utf8")).toBe(readFileSync(history.metadata.path, "utf8"));
  const exportedStore = new ChatHistoryStore(root, join(root, "sessions"));
  stores.push(exportedStore);
  const reopened = (await exportedStore.prepare({ session: path }, identity))!;
  expect(reopened.messages).toHaveLength(3);
  expect(historyBlocks(reopened.messages).at(-1)).toMatchObject({ type: "tool", status: "completed", args: { path: "input.txt" } });
  const html = readFileSync(await exportChat(history, join(root, "export.html")), "utf8");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("x".repeat(70_000));
  await expect(exportChat(history, path)).rejects.toThrow();
});

test("slash commands inspect, export and select sessions without invoking the agent", async () => {
  const { root, store } = fixture();
  const history = (await store.prepare({}, identity))!;
  await (await history.session.createBranch("main", null, ctx)).appendMessage(user, ctx);
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


test.each(["", "{\"kind\":", "# not JSON", "null", "true", "42", '"text"', "[]", "{}"])(
  "malformed session header %j gives the expected format hint", async (content) => {
    const { root, store } = fixture();
    const path = join(root, "invalid.jsonl");
    writeFileSync(path, content);
    await expect(store.prepare({ session: path }, identity)).rejects.toThrow(
      "不支持的 Doctor 会话文件；需要 Pi 0.87 JSONL 会话格式",
    );
  },
);

test("session file read failures preserve their filesystem error", async () => {
  const { root, store } = fixture();
  await expect(store.prepare({ session: join(root, "missing.jsonl") }, identity))
    .rejects.toMatchObject({ code: "ENOENT" });
});


test("fork creates an independent session and leaves the original bytes unchanged", async () => {
  const { root, store } = fixture();
  const history = (await store.prepare({}, identity))!;
  const agent = await Agent.create({ session: history.session, env: new NodeExecutionEnv({ cwd: root }),
    llm: { provider: "openai", model: "test", apiKey: "secret", fetch: async () => sse("original answer") } });
  await turn(agent, "original question");
  await agent.dispose();
  const before = readFileSync(history.metadata.path, "utf8");
  const fork = (await store.prepare({ fork: history.metadata.path }, identity))!;
  expect(fork.metadata.id).not.toBe(history.metadata.id);
  expect(fork.metadata.path).not.toBe(history.metadata.path);
  expect(fork.metadata.parentSessionId).toBe(history.metadata.id);
  expect(statSync(fork.metadata.path).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(fork.messages)).toContain("original answer");
  let request = "";
  const child = await Agent.create({ session: fork.session, env: new NodeExecutionEnv({ cwd: root }),
    llm: { provider: "openai", model: "test", apiKey: "secret", fetch: async (_input, init) => {
      request = String(init?.body); return sse("fork answer");
    } } });
  await turn(child, "fork question");
  await child.dispose();
  expect(request).toContain("original question");
  expect(request).toContain("original answer");
  expect(readFileSync(history.metadata.path, "utf8")).toBe(before);
  const resumed = (await store.prepare({ session: fork.metadata.id }, identity))!;
  expect(JSON.stringify(resumed.messages)).toContain("fork answer");
  await resumed.session.close(ctx);
  const byId = (await store.prepare({ fork: history.metadata.id }, identity))!;
  expect(byId.metadata.parentSessionId).toBe(history.metadata.id);
  expect(JSON.stringify(byId.messages)).not.toContain("fork answer");
  await byId.session.close(ctx);
  await expect(store.prepare({ fork: history.metadata.path }, { ...identity, profile: "other" })).rejects.toThrow("profile");
  await expect(store.prepare({ fork: history.metadata.path }, { ...identity, plugin: "other" })).rejects.toThrow("Plugin");
});

test("fork rejects conflicting session selectors and remote or ephemeral mode", () => {
  for (const flags of [{ continue: true }, { resume: true as const }, { session: "source" }, { noSession: true }, { server: true }]) {
    expect(() => validateSessionFlags({ fork: "source", ...flags })).toThrow();
  }
});

for (const flags of [{ fork: "" }, { fork: "", session: "existing-session-id" }]) {
  test(`empty --fork rejects before creating a session${flags.session ? " when --session is also specified" : ""}`, async () => {
    const { root, store } = fixture();
    await expect(store.prepare(flags, identity)).rejects.toThrow("--fork 需要非空的会话路径或 ID");
    expect(existsSync(join(root, "sessions"))).toBe(false);
  });
}
