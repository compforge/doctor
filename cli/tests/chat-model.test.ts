import { describe, expect, test } from "bun:test";

import { createDoctorModel, projectChatState } from "../src/chat/model";

describe("Doctor AgentUE model projection", () => {
  test("preserves the Doctor banner and projects messages into chat-tui state", () => {
    const model = createDoctorModel({
      profileName: "local",
      profile: {
        readonly: true,
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

    const state = projectChatState(model, "0.0.1");

    expect(state.timeline.header).toContain("╭─◯   ◯─╮");
    expect(state.timeline.header).toContain("agent    local");
    expect(state.timeline.items).toEqual([{
      type: "message",
      id: "m1",
      role: "agent",
      author: "doctor",
      text: "hello",
      format: "markdown",
      streaming: true,
    }]);
  });
});
