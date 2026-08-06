import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PatchEmitter } from "@compforge/agentue/ui";
import {
  createServiceCatalog,
  type PluginDefinition,
} from "@compforge/doctor-plugin";

import { bootstrap } from "../src/app/bootstrap";

test("bootstrap uses the local Agent and injects embedded Plugin Skills even when server is configured", async () => {
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
  const skillPath = join(directory, "skills", "sample-ops", "SKILL.md");
  mkdirSync(join(directory, "skills", "sample-ops"), { recursive: true });
  writeFileSync(skillPath, "PRIVATE COMPLETE INSTRUCTIONS");
  writeFileSync(configPath, [
    "default_profile: local",
    "profiles:",
    "  local:",
    "    server: http://127.0.0.1:1",
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
      filePath: skillPath,
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
  expect(serialized).toContain(`<location>${skillPath}</location>`);
  expect(serialized).not.toContain("PRIVATE COMPLETE INSTRUCTIONS");
});

test("bootstrap keeps the remote adapter available behind explicit --server", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/connections") {
        return Response.json({ connection_id: "connection-test" }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const directory = mkdtempSync(join(tmpdir(), "doctor-server-routing-"));
  const configPath = join(directory, "config.yaml");
  writeFileSync(configPath, [
    "default_profile: remote",
    "profiles:",
    "  remote:",
    `    server: http://127.0.0.1:${server.port}`,
    "    readonly: true",
    "    llm:",
    "      provider: openai",
    "      endpoint: http://llm.invalid/v1",
    "      api_key: test",
    "      model: test",
    "",
  ].join("\n"));

  try {
    const result = await bootstrap({ config: configPath, server: true, verbose: false });
    expect(result.model.meta.mode).toBe("server");
    expect(result.model.meta.server).toBe(`http://127.0.0.1:${server.port}`);
    expect(requests).toEqual(["GET /healthz", "POST /connections"]);
  } finally {
    server.stop(true);
  }
});
