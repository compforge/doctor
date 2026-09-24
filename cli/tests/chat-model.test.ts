import { describe, expect, test } from "bun:test";

import { createDoctorModel, projectChatState } from "../src/chat/model";

describe("Doctor AgentUE model projection", () => {
  test("projects messages into chat-tui state without printing a banner", () => {
    const model = createDoctorModel({
      profileName: "local",
      profile: {
        readonly: true,
        server: "http://doctor.test",
        llm: { provider: "openai", api_key: "secret", model: "gpt-test" },
      },
      mode: "local",
      warnings: [],
    });
    model.blocks.push({
      id: "m1",
      type: "message",
      role: "agent",
      content: "hello",
      streaming: true,
    });
    model.meta.queued.push({ id: "q1", text: "follow up" });

    const state = projectChatState(model);

    expect(state.timeline.header).toBeUndefined();
    expect(state.timeline.items).toEqual([{
      type: "message",
      id: "m1",
      role: "agent",
      author: "doctor",
      text: "hello",
      format: "markdown",
      streaming: true,
    }]);
    expect(state.queue?.items).toEqual([{
      id: "q1",
      text: "follow up",
      tag: "queued",
    }]);
  });
});

test("shows executed bash command and real model thinking in transcript blocks", () => {
  const model = createDoctorModel({
    profileName: "local", profile: { readonly: true }, mode: "local", warnings: [],
  });
  model.blocks.push({ id: "thought-1", type: "thought", status: "completed", content: "checking evidence" });
  model.blocks.push({
    id: "tool-1", type: "tool", tool_name: "bash", status: "completed",
    args: { command: "# trace\nascli trace --biz-id example" }, result: "done",
  });

  const state = projectChatState(model);
  expect(state.timeline.showThoughts).toBe(true);
  expect(state.timeline.items[0]).toMatchObject({
    kind: "thought", title: "Thinking", content: { type: "text", text: "checking evidence" },
  });
  expect(state.timeline.items[1]).toMatchObject({
    title: "bash · ascli trace --biz-id example",
    content: [
      { type: "command", command: "# trace\nascli trace --biz-id example" },
      { type: "output", lines: ["done"] },
    ],
  });
});
