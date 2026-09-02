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
  });
});
