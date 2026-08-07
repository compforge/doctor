import { expect, test } from "bun:test";
import type { Model, ModelInference } from "@compforge/doctor-plugin";

import { selectChatModel } from "../src/app/bootstrap";
import { createModelInferenceFetch } from "../src/chat";

test("chat model selection only offers LLM models", async () => {
  const models: Model[] = [{
    id: "embedding-1",
    name: "Embedding",
    type: "embedding",
    provider: "sample",
    inference: { baseUrl: "http://inference/v1", model: "embedding-1" },
  }, {
    id: "rerank-1",
    name: "Rerank",
    type: "rerank",
    provider: "sample",
    inference: { baseUrl: "http://inference/v1", model: "rerank-1" },
  }, {
    id: "chat-1",
    name: "Chat",
    type: "llm",
    provider: "sample",
    inference: { baseUrl: "http://inference/v1", model: "chat-backend" },
  }];
  let choices: readonly Model[] = [];

  const selected = await selectChatModel(models, async (offered) => {
    choices = offered;
    return offered[0];
  });

  expect(choices.map((model) => model.type)).toEqual(["llm"]);
  expect(selected?.inference).toEqual({
    baseUrl: "http://inference/v1",
    model: "chat-backend",
  });
});

test("Plugin inference is adapted to an OpenAI-compatible fetch", async () => {
  let invocation: { path: string; body: Record<string, unknown>; signal: AbortSignal } | undefined;
  const inference: ModelInference = {
    invoke: async () => ({
      ok: true,
      statusCode: 200,
      statusText: "OK",
      headers: {},
      text: "",
      durationMs: 1,
    }),
    invokeStream: async (path, body, signal) => {
      invocation = { path, body, signal };
      return {
        statusCode: 200,
        statusText: "OK",
        headers: { "content-type": "text/event-stream" },
        body: new Response("data: [DONE]\n\n").body,
      };
    },
  };
  const controller = new AbortController();
  const response = await createModelInferenceFetch(inference)("http://catalog.invalid/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "chat-backend", stream: true }),
    signal: controller.signal,
  });

  expect(invocation?.path).toBe("/chat/completions");
  expect(invocation?.body).toMatchObject({ model: "chat-backend", stream: true });
  expect(invocation?.signal).toBe(controller.signal);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("data: [DONE]\n\n");
});
