export type McpTransportKind = "sse" | "streamable-http";

export interface McpClientOptions {
  endpoint: string;
  transport: McpTransportKind;
  headers?: Record<string, string>;
  timeoutMs: number;
}

export interface McpJsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface McpRuntimeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallCapture {
  response?: McpJsonRpcMessage;
  error?: string;
  durationMs: number;
}

export interface McpTranscriptEntry {
  at: string;
  direction: "in" | "out" | "transport";
  event?: string;
  payload?: McpJsonRpcMessage;
  error?: string;
}
