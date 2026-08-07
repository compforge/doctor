import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PatchEmitter } from "@compforge/agentue/ui";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

import { Agent } from "../src/agent";

test("Agent uses the host-provided LLM transport", async () => {
  let request: Request | undefined;
  const agent = new Agent({
    llm: {
      provider: "openai",
      apiKey: "adapter-owned",
      model: "chat-backend",
      endpoint: "http://inference.invalid/v1",
      fetch: async (input, init) => {
        request = input instanceof Request
          ? input
          : new Request(input instanceof URL ? input.toString() : input, init);
        return new Response([
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"chat-backend","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"chat-backend","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"chat-backend","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
      },
    },
    env: new NodeExecutionEnv({ cwd: mkdtempSync(join(tmpdir(), "doctor-agent-transport-")) }),
  });

  try {
    for await (const _event of agent.run("hello", { emitter: new PatchEmitter() })) {
      // Drain the complete AgentUE stream.
    }
  } finally {
    await agent.dispose();
  }

  expect(request?.url).toBe("http://inference.invalid/v1/chat/completions");
  expect(await request?.clone().json()).toMatchObject({ model: "chat-backend", stream: true });
});
