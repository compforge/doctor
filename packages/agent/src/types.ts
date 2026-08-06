import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BaseBlock, PatchEmitter, PatchEvent } from "@compforge/agentue/ui";

export interface MessageBlock extends BaseBlock {
  type: "message";
  role: "user" | "agent";
  content: string;
  streaming?: boolean;
}

export interface ToolBlock extends BaseBlock {
  type: "tool";
  tool_name: string;
  status: "in_progress" | "completed" | "failed";
  args?: unknown;
  result?: string;
  duration_ms?: number;
  truncated?: boolean;
  timeout_ms?: number;
}

export interface InfoBlock extends BaseBlock {
  type: "info";
  tone: "muted" | "warn" | "error";
  content: string;
}

export type AgentBlock = MessageBlock | ToolBlock | InfoBlock;

export interface RunContext {
  emitter: PatchEmitter;
}

export interface AgentSource {
  run(text: string, context: RunContext): AsyncIterable<PatchEvent>;
  abort(): void;
  dispose(): Promise<void>;
}

export interface LlmConfig {
  provider: "openai" | "deepseek";
  apiKey: string;
  model: string;
  endpoint?: string;
  thinking?: boolean;
}

/** A Plugin owns the Skill files and passes this resolved view to the agent. */
export interface Skill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  readResource?(relativePath: string, signal?: AbortSignal): Promise<string>;
}

export interface AgentOptions {
  llm: LlmConfig;
  skills?: readonly Skill[];
  tools?: readonly AgentTool[];
  systemPrompt?: string;
  verbose?: boolean;
}
