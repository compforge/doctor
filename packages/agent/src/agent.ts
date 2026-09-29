import {
  AgentHarness, BACKGROUND_CONTEXT, MemorySessionRepo, formatSkillsForSystemPrompt,
  DEFAULT_COMPACTION_SETTINGS, type AgentLane, type HarnessEventPayload, type RunResult, type CompactionResult,
} from "@earendil-works/pi-agent-core";
import type { PatchEvent } from "@compforge/agentue/ui";
import { AsyncQueue } from "./async-queue";
import { createExecutionTools } from "./tools";
import { createModelAccess } from "./model";
import type { AgentOptions, AgentSource, InfoBlock, MessageBlock, RunContext, ThoughtBlock, ToolBlock } from "./types";

const ctx = BACKGROUND_CONTEXT;
const DEFAULT_SYSTEM_PROMPT = [
  "You are Doctor, a concise diagnostic assistant for software and Kubernetes incidents.",
  "Ask for missing evidence before drawing conclusions. Distinguish observations from hypotheses.",
  "Never claim that you executed a diagnostic action unless a tool result proves it.",
].join("\n");

/** Pi owns durable conversation state; Doctor only supplies capabilities and UI projection. */
export class Agent implements AgentSource {
  private active?: Promise<unknown>;
  private constructor(
    private readonly options: AgentOptions,
    private readonly harness: AgentHarness<{ env: AgentOptions["env"] }>,
    private readonly lane: AgentLane,
    readonly recoveredInterruptedRun: boolean,
  ) {}

  static async create(options: AgentOptions): Promise<Agent> {
    const session = options.session ?? await new MemorySessionRepo().create({}, ctx);
    try {
      const { models, model } = createModelAccess(options.llm);
      const tools = [...(options.tools ?? []), ...createExecutionTools()];
      if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("duplicate Agent tool name");
      const { harness } = await AgentHarness.create({
        session, models, model, tools, toolContext: { env: options.env },
        activeToolNames: tools.map((tool) => tool.name),
        toolExecution: "sequential",
        thinkingLevel: options.llm.thinking ? "medium" : "off",
        resources: { skills: [...(options.skills ?? [])], promptTemplates: [] },
        systemPrompt: [options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, options.contextPrompt,
          formatSkillsForSystemPrompt([...(options.skills ?? [])])].filter(Boolean).join("\n\n"),
        // Leave room for summaries and recent turns even on smaller configured models.
        compaction: options.compaction ?? { ...DEFAULT_COMPACTION_SETTINGS,
          reserveTokens: Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, Math.floor(model.contextWindow / 4)),
          keepRecentTokens: Math.min(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens, Math.floor(model.contextWindow / 4)) },
      }, ctx);
      const lane = await harness.lane("main", ctx);
      const recoveredInterruptedRun = (await lane.inspectExecution(ctx)).current !== null;
      // Opening a chat must not repeat a possibly executed shell command. Pi reconciles
      // abandoned operations as aborted; the user can continue from the saved evidence.
      if (recoveredInterruptedRun) await lane.abort(ctx);
      // The host's current model choice wins on restore; credentials never enter session storage.
      await lane.setModel({ provider: model.provider, modelId: model.id }, ctx);
      await lane.setThinkingLevel(options.llm.thinking ? "medium" : "off", ctx);
      await lane.setActiveTools(tools.map((tool) => tool.name), ctx);
      return new Agent(options, harness, lane, recoveredInterruptedRun);
    } catch (error) {
      await session.close(ctx);
      await options.env.cleanup(ctx);
      throw error;
    }
  }

  run(text: string, context: RunContext): AsyncIterable<PatchEvent> {
    return this.execute(() => this.lane.prompt(text, undefined, ctx), context);
  }

  compact(instructions: string | undefined, context: RunContext): AsyncIterable<PatchEvent> {
    return this.execute(() => this.lane.compact({ customInstructions: instructions }, ctx), context);
  }

  private async *execute(operation: () => Promise<RunResult | CompactionResult>, context: RunContext): AsyncIterable<PatchEvent> {
    const queue = new AsyncQueue<PatchEvent>();
    const state: EventState = { assistantHasText: false,
      setAssistantId: (id) => { state.assistantId = id; },
      setAssistantHasText: (value) => { state.assistantHasText = value; },
      setThoughtId: (id) => { state.thoughtId = id; } };
    const subscriptions = (["message_start", "message_update", "message_end", "tool_start", "tool_end",
      "compaction_start", "compaction_end", "retry_scheduled"] as const).map((type) => this.harness.events.on(type, (event) => {
        for (const patch of mapEvent(event, context, state)) queue.push(patch);
      }));
    this.active = operation().then((result) => {
      // Convenience operations return typed failures, including terminal provider/storage errors.
      assertOperation(result);
      queue.close();
    }).catch((error: unknown) => { queue.fail(error); });
    try { yield* queue; }
    finally { subscriptions.forEach((off) => off()); await this.active; this.active = undefined; }
  }

  abort(): void { void this.lane.abort(ctx).catch(() => undefined); }

  async dispose(): Promise<void> {
    try {
      await this.lane.abort(ctx);
      await this.active;
      await this.lane.waitForIdle(ctx);
    } finally {
      try { await this.harness.close(ctx); }
      finally { await this.options.env.cleanup(ctx); }
    }
  }
}

function assertOperation(result: RunResult | CompactionResult): void {
  if (!result.ok) throw result.error;
  const terminals = "compaction" in result.value
    ? [result.value.compaction, ...(result.value.run ? [result.value.run] : [])] : [result.value];
  for (const terminal of terminals) {
    if (terminal.status === "failed") throw new Error(terminal.error?.message ?? "Pi operation failed");
    if (terminal.status === "suspended") throw new Error("模型请求处于 suspended 状态，当前 Doctor 不支持 deferred 模型");
  }
}

export interface EventState {
  assistantId?: string;
  assistantHasText: boolean;
  thoughtId?: string;
  setAssistantId(id: string): void;
  setAssistantHasText(hasText: boolean): void;
  setThoughtId(id: string | undefined): void;
}

export function mapEvent(event: HarnessEventPayload, context: RunContext, state: EventState): PatchEvent[] {
  const { emitter } = context;
  switch (event.type) {
    case "message_start": {
      if (event.message.role !== "assistant") return [];
      const id = `assistant-${crypto.randomUUID()}`;
      state.setAssistantId(id);
      state.setAssistantHasText(false);
      state.setThoughtId(undefined);
      return [];
    }
    case "message_update": {
      const update = event.event;
      if (update.type === "text_delta") {
        if (!state.assistantId || update.delta.length === 0) return [];
        if (!state.assistantHasText) {
          state.setAssistantHasText(true);
          return [emitter.blockSet({
            id: state.assistantId,
            type: "message",
            role: "agent",
            content: update.delta,
            streaming: true,
          } satisfies MessageBlock, { eventType: update.type })];
        }
        return [emitter.blockAppend(
          { id: state.assistantId, type: "message", content: update.delta },
          { mask: "block.content", eventType: update.type },
        )];
      }
      if (update.type === "thinking_start") {
        const id = `thought-${crypto.randomUUID()}`;
        state.setThoughtId(id);
        return [emitter.blockSet({
          id,
          type: "thought",
          status: "in_progress",
          content: "",
        } satisfies ThoughtBlock, { eventType: update.type })];
      }
      if (update.type === "thinking_delta" && state.thoughtId && update.delta) {
        return [emitter.blockAppend(
          { id: state.thoughtId, type: "thought", content: update.delta },
          { mask: "block.content", eventType: update.type },
        )];
      }
      if (update.type === "thinking_end" && state.thoughtId) {
        return [emitter.blockSet({
          id: state.thoughtId,
          type: "thought",
          status: "completed",
          content: update.content,
        } satisfies ThoughtBlock, { eventType: update.type })];
      }
      return [];
    }
    case "message_end": {
      if (event.message.role !== "assistant" || !state.assistantId) return [];
      const content = assistantText(event.message);
      const patches: PatchEvent[] = content || state.assistantHasText
        ? [emitter.blockSet({
            id: state.assistantId,
            type: "message",
            role: "agent",
            content,
            streaming: false,
          } satisfies MessageBlock, { eventType: event.type })]
        : [];
      return patches;
    }
    case "tool_start":
      return [emitter.blockSet({
        id: event.toolCallId,
        type: "tool",
        tool_name: event.toolName,
        status: "in_progress",
        args: event.args,
      } satisfies ToolBlock, { eventType: event.type })];
    case "tool_end": {
      const result = {
        id: event.toolCallId,
        type: "tool",
        tool_name: event.toolName,
        status: event.isError ? "failed" : "completed",
        result: stringifyResult(event.result),
      } satisfies ToolBlock;
      // Set only changed fields so the start event's command arguments survive completion.
      return [
        emitter.blockSet(result, { mask: "block.result", eventType: event.type }),
        emitter.blockSet(result, { mask: "block.status", eventType: event.type }),
      ];
    }
    case "compaction_start":
      return [emitter.blockSet({ id: `compact-${event.runId}`, type: "info", tone: "muted",
        content: `正在压缩上下文（${event.reason}）…` } satisfies InfoBlock)];
    case "compaction_end":
      return [emitter.blockSet({ id: `compact-${event.runId}`, type: "info",
        tone: event.status === "failed" ? "error" : "muted",
        content: event.status === "completed" ? "上下文压缩完成，完整聊天记录仍保留"
          : `上下文压缩${event.status === "aborted" ? "已中断" : event.status === "declined" ? "未执行" : `失败：${event.error?.message ?? "未知错误"}`}`,
      } satisfies InfoBlock)];
    case "retry_scheduled":
      return [emitter.blockSet({ id: `retry-${event.runId}`, type: "info", tone: "warn",
        content: `模型请求重试 ${event.attempt}/${event.maxAttempts}：${event.errorMessage}` } satisfies InfoBlock)];
    default:
      return [];
  }
}

function assistantText(message: Extract<HarnessEventPayload, { type: "message_end" }>["message"]): string {
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
