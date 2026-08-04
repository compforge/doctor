import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  McpCallCapture,
  McpClientOptions,
  McpJsonRpcMessage,
  McpRuntimeTool,
  McpTranscriptEntry,
} from "./model";

class RecordingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly transport: Transport,
    private readonly transcript: McpTranscriptEntry[],
  ) {
    this.transport.onclose = () => this.onclose?.();
    this.transport.onerror = (error) => {
      this.transcript.push({
        at: new Date().toISOString(),
        direction: "transport",
        event: "error",
        error: error.message,
      });
      this.onerror?.(error);
    };
    this.transport.onmessage = (message, extra) => {
      this.transcript.push({
        at: new Date().toISOString(),
        direction: "in",
        event: "message",
        payload: message as McpJsonRpcMessage,
      });
      this.onmessage?.(message, extra);
    };
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  async start(): Promise<void> {
    await this.transport.start();
    this.transcript.push({
      at: new Date().toISOString(),
      direction: "transport",
      event: "open",
    });
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.transcript.push({
      at: new Date().toISOString(),
      direction: "out",
      event: "message",
      payload: message as McpJsonRpcMessage,
    });
    await this.transport.send(message, options);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(version);
  }
}

function createTransport(options: McpClientOptions): Transport {
  const endpoint = new URL(options.endpoint);
  const requestInit = options.headers ? { headers: options.headers } : undefined;
  if (options.transport === "sse") {
    return new SSEClientTransport(endpoint, { requestInit });
  }
  return new StreamableHTTPClientTransport(endpoint, { requestInit });
}

/** Protocol-level MCP access. Domain configuration and diagnosis stay with the caller. */
export class McpClient {
  readonly transcript: McpTranscriptEntry[] = [];
  readonly #client = new Client({ name: "doctor", version: "mcp-diagnosis" }, { capabilities: {} });
  readonly #transport: RecordingTransport;
  #closed = false;

  constructor(private readonly options: McpClientOptions) {
    this.#transport = new RecordingTransport(createTransport(options), this.transcript);
  }

  async connect(): Promise<void> {
    try {
      await this.#withTimeout(
        this.#client.connect(this.#transport, { timeout: this.options.timeoutMs }),
        "MCP 连接超时",
      );
    } catch (error) {
      await this.close();
      throw new Error(`MCP 连接失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listTools(): Promise<{ tools: McpRuntimeTool[]; response: McpJsonRpcMessage }> {
    const start = this.transcript.length;
    const result = await this.#client.listTools({}, { timeout: this.options.timeoutMs });
    const response = this.#responseFor("tools/list", start) ?? { jsonrpc: "2.0", result };
    return {
      tools: result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      response,
    };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallCapture> {
    const started = Date.now();
    const transcriptStart = this.transcript.length;
    try {
      const result = await this.#client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: this.options.timeoutMs },
      );
      return {
        response: this.#responseFor("tools/call", transcriptStart) ?? { jsonrpc: "2.0", result },
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        response: this.#responseFor("tools/call", transcriptStart),
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#client.close().catch(() => undefined);
  }

  #responseFor(method: string, start: number): McpJsonRpcMessage | undefined {
    const entries = this.transcript.slice(start);
    const request = entries.find((entry) => entry.direction === "out" && entry.payload?.method === method)?.payload;
    if (request?.id === undefined || request.id === null) return undefined;
    return entries.find((entry) => entry.direction === "in" && entry.payload?.id === request.id)?.payload;
  }

  async #withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), this.options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function serializeMcpTranscript(entries: readonly McpTranscriptEntry[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
