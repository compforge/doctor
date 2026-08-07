import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { BaseBlock, PatchEmitter, PatchEvent } from "@compforge/agentue/ui";
import type { PluginSkill } from "@compforge/doctor-plugin";

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
  /** Host-owned transport override, used when credentials and routing stay behind an adapter. */
  fetch?: LlmFetch;
}

export type LlmFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type Skill = PluginSkill;

export interface AgentOptions {
  llm: LlmConfig;
  /** Execution environment owned and cleaned up by this Agent. */
  env: ExecutionEnv;
  skills?: readonly PluginSkill[];
  tools?: readonly AgentTool[];
  systemPrompt?: string;
  /** Host-owned facts appended to the system prompt for this Agent instance. */
  contextPrompt?: string;
  verbose?: boolean;
}
