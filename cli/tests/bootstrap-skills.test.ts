import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PatchEmitter } from "@compforge/agentue/ui";
import {
  createServiceCatalog,
  type PluginDefinition,
} from "@compforge/doctor-plugin";

import { bootstrap } from "../src/app/bootstrap";

test("bootstrap injects the embedded Plugin Skills into the local Agent", async () => {
  let requestBody: unknown;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requestBody = await request.json();
      return new Response([
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const directory = mkdtempSync(join(tmpdir(), "doctor-plugin-skills-"));
  const configPath = join(directory, "config.yaml");
  writeFileSync(configPath, [
    "default_profile: local",
    "profiles:",
    "  local:",
    "    llm:",
    "      provider: openai",
    `      endpoint: http://127.0.0.1:${server.port}/v1`,
    "      api_key: test",
    "      model: test",
    "",
  ].join("\n"));
  const plugin = {
    id: "sample",
    services: createServiceCatalog([]),
    skills: [{
      name: "sample-ops",
      description: "Diagnose sample services.",
      content: "PRIVATE COMPLETE INSTRUCTIONS",
      filePath: "plugin://sample/skills/sample-ops/SKILL.md",
    }],
  } satisfies PluginDefinition;

  let agent: Awaited<ReturnType<typeof bootstrap>>["agent"] | undefined;
  try {
    const result = await bootstrap({ config: configPath, verbose: false }, plugin);
    agent = result.agent;
    for await (const _event of agent.run("diagnose", { emitter: new PatchEmitter() })) {
      // Consume the complete AgentUE stream so the model request reaches its terminal event.
    }
  } finally {
    await agent?.dispose();
    server.stop(true);
  }

  const serialized = JSON.stringify(requestBody);
  expect(serialized).toContain("<name>sample-ops</name>");
  expect(serialized).not.toContain("PRIVATE COMPLETE INSTRUCTIONS");
});
