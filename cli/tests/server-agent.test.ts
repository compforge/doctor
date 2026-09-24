import { describe, expect, test } from "bun:test";

import { createDoctorModel } from "../src/chat/model";
import { ServerAgent, type ServerClient } from "../src/chat/server-agent";
import { Session } from "../src/chat/session";
import type { AgentEventBase, ProfileUpload } from "../src/protocol";

class FakeServerClient implements ServerClient {
  async createConnection(_profile: ProfileUpload): Promise<string> {
    return "connection-2";
  }

  async deleteConnection(_connectionId: string): Promise<void> {}

  async *streamMessage(): AsyncGenerator<AgentEventBase> {
    yield event("session.created");
    yield event("text.chunk", { content: "hello" });
    yield event("run.completed");
  }
}

describe("ServerAgent", () => {
  test("adapts legacy doctor-server SSE into the shared AgentUE model", async () => {
    const profile = {
      readonly: true,
      server: "http://doctor.test",
      llm: { provider: "openai", api_key: "secret", model: "gpt-test" },
    };
    const agent = new ServerAgent({
      client: new FakeServerClient(),
      connectionId: "connection-1",
      profileName: "server",
      profile,
      state: { conversations: {} },
      statePath: "/private/tmp/unused-doctor-state.yaml",
    });
    const session = new Session(createDoctorModel({
      profileName: "server",
      profile,
      mode: "server",
      warnings: [],
      connectionId: "connection-1",
    }), agent);

    await session.submit("question");

    expect(session.getModel().meta.conversation_id).toBe("conversation-1");
    expect(session.getModel().blocks.at(-1)).toMatchObject({
      type: "message",
      role: "agent",
      content: "hello",
      streaming: false,
    });
  });
});

function event(eventType: string, extra: Record<string, unknown> = {}): AgentEventBase {
  return {
    event_id: crypto.randomUUID(),
    event_type: eventType,
    session_id: "conversation-1",
    run_id: "run-1",
    occurred_at: Date.now(),
    ...extra,
  };
}

test("server thinking chunks and tool arguments remain visible after completion", async () => {
  class ToolServerClient extends FakeServerClient {
    override async *streamMessage(): AsyncGenerator<AgentEventBase> {
      yield event("thinking.chunk", { content: "checking " });
      yield event("thinking.chunk", { content: "evidence" });
      yield event("tool_call.started", {
        tool_call_id: "call-1", tool_name: "bash", args: { command: "ascli data example" },
      });
      yield event("tool_call.completed", {
        tool_call_id: "call-1", tool_name: "bash", status: "completed", content: "done",
      });
      yield event("run.completed");
    }
  }
  const profile = { readonly: true, server: "http://doctor.test" };
  const session = new Session(createDoctorModel({
    profileName: "server", profile, mode: "server", warnings: [],
  }), new ServerAgent({
    client: new ToolServerClient(), connectionId: "connection-1", profileName: "server",
    profile, state: { conversations: {} }, statePath: "/private/tmp/unused-doctor-state.yaml",
  }));

  await session.submit("question");
  expect(session.getModel().blocks.filter((block) => block.type !== "message")).toMatchObject([
    { type: "thought", status: "completed", content: "checking evidence" },
    { type: "tool", status: "completed", args: { command: "ascli data example" }, result: "done" },
  ]);
});
