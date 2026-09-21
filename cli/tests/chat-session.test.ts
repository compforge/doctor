import { describe, expect, spyOn, test } from "bun:test";
import type { AgentSource, RunContext } from "@compforge/doctor-agent";
import type { PatchEvent } from "@compforge/agentue/ui";

import { createDoctorModel } from "../src/chat/model";
import { Session } from "../src/chat/session";

class EchoAgent implements AgentSource {
  aborted = false;

  async *run(text: string, context: RunContext): AsyncIterable<PatchEvent> {
    const id = `reply-${text}`;
    yield context.emitter.blockSet({
      id,
      type: "message",
      role: "agent",
      content: "",
      streaming: true,
    });
    yield context.emitter.blockAppend(
      { id, type: "message", content: `echo ${text}` },
      { mask: "block.content" },
    );
    yield context.emitter.blockSet({
      id,
      type: "message",
      role: "agent",
      content: `echo ${text}`,
      streaming: false,
    });
  }

  abort(): void {
    this.aborted = true;
  }

  async dispose(): Promise<void> {}
}

class BlockingAgent implements AgentSource {
  readonly runs: string[] = [];
  private release?: () => void;

  async *run(text: string): AsyncIterable<PatchEvent> {
    this.runs.push(text);
    await new Promise<void>((resolve) => { this.release = resolve; });
  }

  abort(): void {
    this.release?.();
  }

  async dispose(): Promise<void> {}
}

class FailingAgent implements AgentSource {
  async *run(): AsyncIterable<PatchEvent> {
    throw new Error("model connection reset");
  }

  abort(): void {}
  async dispose(): Promise<void> {}
}

describe("Session", () => {
  test("owns turn state while agents only produce AgentUE patches", async () => {
    const agent = new EchoAgent();
    const session = new Session(createModel(), agent);

    await session.submit("hello");

    expect(session.getModel().meta.busy).toBe(false);
    expect(session.getModel().meta.turn_count).toBe(1);
    expect(session.getModel().blocks.map((block) => block.type)).toEqual(["message", "message"]);
    expect(session.getModel().blocks.at(-1)).toMatchObject({
      role: "agent",
      content: "echo hello",
      streaming: false,
    });
  });

  test("dispose aborts the active turn without draining queued prompts", async () => {
    const agent = new BlockingAgent();
    const session = new Session(createModel(), agent);

    void session.submit("first");
    await session.submit("queued");
    await session.dispose();

    expect(agent.runs).toEqual(["first"]);
    expect(session.getModel().meta.queued).toEqual([]);
    await expect(session.submit("after-dispose")).rejects.toThrow("disposed");
  });

  test("agent turn failure is visible in the UI and stderr without a log path", async () => {
    const write = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const session = new Session(createModel(), new FailingAgent(), "test@0.0.1");
      await session.submit("hello");
      expect(session.getModel().meta.error?.message).toBe("model connection reset");
      const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(output).toContain("model connection reset");
      expect(output).toContain("Plugin test@0.0.1");
      expect(output).not.toContain("技术详情:");
    } finally { write.mockRestore(); }
  });
});

function createModel() {
  return createDoctorModel({
    profileName: "local",
    profile: {
      readonly: true,
      llm: { provider: "openai", api_key: "secret", model: "gpt-test" },
    },
    mode: "local",
    warnings: [],
  });
}
