import {
  Agent as PiAgent,
  type AgentEvent,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { PatchEvent } from "@compforge/agentue/ui";

import { AsyncQueue } from "./async-queue";
import { createSkillTools, formatSkillCatalog } from "./skills";
import type {
  AgentOptions,
  AgentSource,
  InfoBlock,
  MessageBlock,
  RunContext,
  ToolBlock,
} from "./types";

const DEFAULT_ENDPOINTS = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
} as const;

const DEFAULT_SYSTEM_PROMPT = [
  "You are Doctor, a concise diagnostic assistant for software and Kubernetes incidents.",
  "Ask for missing evidence before drawing conclusions. Distinguish observations from hypotheses.",
  "Never claim that you executed a diagnostic action unless a tool result proves it.",
].join("\n");

export class Agent implements AgentSource {
  private readonly agent: PiAgent;
  private readonly verbose: boolean;

  constructor(options: AgentOptions) {
    const skills = options.skills ?? [];
    const tools = mergeTools(options.tools ?? [], createSkillTools(skills));
    const skillCatalog = formatSkillCatalog(skills);
    this.verbose = options.verbose ?? false;
    this.agent = new PiAgent({
      initialState: {
        systemPrompt: [options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, skillCatalog]
          .filter(Boolean)
          .join("\n\n"),
        model: createModel(options.llm),
        thinkingLevel: options.llm.thinking ? "medium" : "off",
        tools,
        messages: [],
      },
      getApiKey: () => options.llm.apiKey,
      toolExecution: "sequential",
    });
  }

  async *run(text: string, context: RunContext): AsyncIterable<PatchEvent> {
    const queue = new AsyncQueue<PatchEvent>();
    let assistantId: string | undefined;
    let thoughtId: string | undefined;

    const unsubscribe = this.agent.subscribe((event) => {
      for (const patch of mapEvent(event, context, {
        assistantId,
        thoughtId,
        verbose: this.verbose,
        setAssistantId: (id) => { assistantId = id; },
        setThoughtId: (id) => { thoughtId = id; },
      })) {
        queue.push(patch);
      }
    });

    void this.agent.prompt(text).then(
      () => queue.close(),
      (error) => queue.fail(error),
    );

    try {
      yield* queue;
    } finally {
      unsubscribe();
    }
  }

  abort(): void {
    this.agent.abort();
  }

  async dispose(): Promise<void> {
    this.agent.abort();
    await this.agent.waitForIdle();
  }
}

interface EventState {
  assistantId?: string;
  thoughtId?: string;
  verbose: boolean;
  setAssistantId(id: string): void;
  setThoughtId(id: string): void;
}

function mapEvent(event: AgentEvent, context: RunContext, state: EventState): PatchEvent[] {
  const { emitter } = context;
  switch (event.type) {
    case "message_start": {
      if (event.message.role !== "assistant") return [];
      const id = `assistant-${crypto.randomUUID()}`;
      state.setAssistantId(id);
      return [emitter.blockSet({
        id,
        type: "message",
        role: "agent",
        content: "",
        streaming: true,
      } satisfies MessageBlock, { eventType: event.type })];
    }
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        return state.assistantId
          ? [emitter.blockAppend(
              { id: state.assistantId, type: "message", content: update.delta },
              { mask: "block.content", eventType: update.type },
            )]
          : [];
      }
      if (state.verbose && update.type === "thinking_start") {
        const id = `thought-${crypto.randomUUID()}`;
        state.setThoughtId(id);
        return [emitter.blockSet({
          id,
          type: "info",
          tone: "muted",
          content: "",
        } satisfies InfoBlock, { eventType: update.type })];
      }
      if (state.verbose && update.type === "thinking_delta" && state.thoughtId) {
        return [emitter.blockAppend(
          { id: state.thoughtId, type: "info", content: update.delta },
          { mask: "block.content", eventType: update.type },
        )];
      }
      return [];
    }
    case "message_end": {
      if (event.message.role !== "assistant" || !state.assistantId) return [];
      const patches: PatchEvent[] = [emitter.blockSet({
        id: state.assistantId,
        type: "message",
        role: "agent",
        content: assistantText(event.message),
        streaming: false,
      } satisfies MessageBlock, { eventType: event.type })];
      if (event.message.stopReason === "error" && event.message.errorMessage) {
        patches.push(emitter.error("llm_error", event.message.errorMessage));
      }
      return patches;
    }
    case "tool_execution_start":
      return [emitter.blockSet({
        id: event.toolCallId,
        type: "tool",
        tool_name: event.toolName,
        status: "in_progress",
        args: event.args,
      } satisfies ToolBlock, { eventType: event.type })];
    case "tool_execution_end":
      return [emitter.blockSet({
        id: event.toolCallId,
        type: "tool",
        tool_name: event.toolName,
        status: event.isError ? "failed" : "completed",
        result: stringifyResult(event.result),
      } satisfies ToolBlock, { eventType: event.type })];
    default:
      return [];
  }
}

function assistantText(message: Extract<AgentEvent, { type: "message_end" }>["message"]): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((part) => part && typeof part === "object" && "text" in part
          ? String(part.text)
          : JSON.stringify(part))
        .join("\n");
    }
  }
  return JSON.stringify(result, null, 2);
}

function mergeTools(primary: readonly AgentTool[], skillTools: readonly AgentTool[]): AgentTool[] {
  const tools = [...primary, ...skillTools];
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`duplicate Agent tool name: ${tool.name}`);
    names.add(tool.name);
  }
  return tools;
}

function createModel(llm: AgentOptions["llm"]): Model<"openai-completions"> {
  const deepseek = llm.provider === "deepseek";
  return {
    id: llm.model,
    name: llm.model,
    api: "openai-completions",
    provider: llm.provider,
    baseUrl: llm.endpoint ?? DEFAULT_ENDPOINTS[llm.provider],
    reasoning: !!llm.thinking || deepseek,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
    ...(deepseek ? {
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek" as const,
      },
    } : {}),
  };
}
