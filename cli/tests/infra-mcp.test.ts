import { describe, expect, test } from "bun:test";
import { McpClient } from "../src/infra/mcp";

describe("infra MCP client", () => {
  test("通过官方 SDK 完成 legacy SSE tools/list 与 tools/call，并保留协议 transcript", async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const traceHeaders: Array<string | null> = [];
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        traceHeaders.push(request.headers.get("traceparent"));
        const url = new URL(request.url);
        if (url.pathname === "/sse") {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(encoder.encode("event: endpoint\ndata: /message\n\n"));
            },
          }), { headers: { "Content-Type": "text/event-stream" } });
        }
        if (url.pathname === "/message") {
          const message = await request.json() as { id?: number; method?: string };
          if (message.id !== undefined) {
            const result = message.method === "tools/list"
              ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
              : message.method === "tools/call"
                ? { content: [{ type: "text", text: "pong" }], isError: false }
                : {
                  protocolVersion: "2024-11-05",
                  capabilities: { tools: {} },
                  serverInfo: { name: "test", version: "1" },
                };
            stream?.enqueue(encoder.encode(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
            ));
          }
          return new Response("accepted", { status: 202 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const client = new McpClient({
      endpoint: `http://127.0.0.1:${server.port}/sse`,
      transport: "sse",
      headers: { traceparent: "00-test-trace-test-span-01" },
      timeoutMs: 2_000,
    });
    try {
      await client.connect();
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["echo"]);
      const called = await client.callTool("echo", { value: "ping" });
      expect(called.error).toBeUndefined();
      expect(called.response?.result).toEqual({ content: [{ type: "text", text: "pong" }], isError: false });
      expect(client.transcript.some((entry) => entry.direction === "in" && entry.event === "message")).toBe(true);
      expect(traceHeaders.length).toBeGreaterThan(0);
      expect(traceHeaders.every((header) => header === "00-test-trace-test-span-01")).toBe(true);
    } finally {
      await client.close();
      server.stop(true);
    }
  });
});
