import { expect, test } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { PatchEmitter } from "@compforge/agentue/ui";

import { mapEvent, type EventState } from "../src/agent";

function event(value: unknown): AgentEvent {
  return value as AgentEvent;
}

function eventState(): EventState {
  const state: EventState = {
    assistantHasText: false,
    verbose: false,
    setAssistantId: (id) => { state.assistantId = id; },
    setAssistantHasText: (hasText) => { state.assistantHasText = hasText; },
    setThoughtId: (id) => { state.thoughtId = id; },
  };
  return state;
}

test("tool-only assistant messages do not create empty message blocks", () => {
  const context = { emitter: new PatchEmitter() };
  const state = eventState();

  expect(mapEvent(event({
    type: "message_start",
    message: { role: "assistant" },
  }), context, state)).toEqual([]);
  expect(mapEvent(event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
      stopReason: "toolUse",
    },
  }), context, state)).toEqual([]);
});

test("assistant message blocks start with the first non-empty text delta", () => {
  const context = { emitter: new PatchEmitter() };
  const state = eventState();

  mapEvent(event({
    type: "message_start",
    message: { role: "assistant" },
  }), context, state);
  expect(mapEvent(event({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "" },
  }), context, state)).toEqual([]);

  const patches = mapEvent(event({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "done" },
  }), context, state);
  expect(JSON.stringify(patches)).toContain('"content":"done"');
  expect(JSON.stringify(patches)).not.toContain('"content":""');
});
