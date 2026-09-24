import type { AgentBlock, ToolBlock } from "@compforge/doctor-agent";
import {
  PROTOCOL_VERSION,
  type ModelMeta,
  type UIModel,
} from "@compforge/agentue/ui";
import type { ChatState, TranscriptItem } from "chat-tui";

import type { Profile } from "../app/config/model";

export type { InfoBlock, MessageBlock, ThoughtBlock, ToolBlock } from "@compforge/doctor-agent";
export type AgentMode = "local" | "server";
export type DoctorBlock = AgentBlock;

export interface QueuedPrompt {
  id: string;
  text: string;
}

export interface DoctorMeta extends ModelMeta {
  profile_name: string;
  mode: AgentMode;
  readonly: boolean;
  model?: string;
  server?: string;
  connection_id?: string;
  conversation_id?: string;
  busy: boolean;
  turn_count: number;
  queued: QueuedPrompt[];
  warnings: string[];
}

export type DoctorModel = UIModel<DoctorBlock, DoctorMeta>;

export interface InitialModelOptions {
  profileName: string;
  profile: Profile;
  mode: AgentMode;
  warnings: string[];
  model?: string;
  connectionId?: string;
  conversationId?: string;
}

export function createDoctorModel(options: InitialModelOptions): DoctorModel {
  const llm = options.profile.llm;
  return {
    version: PROTOCOL_VERSION,
    biz: "doctor.chat",
    meta: {
      profile_name: options.profileName,
      mode: options.mode,
      readonly: options.profile.readonly,
      ...(options.model
        ? { model: options.model }
        : llm?.model
          ? { model: `${llm.provider ?? "?"}/${llm.model}` }
          : {}),
      ...(options.mode === "server" && options.profile.server
        ? { server: options.profile.server }
        : {}),
      ...(options.connectionId ? { connection_id: options.connectionId } : {}),
      ...(options.conversationId ? { conversation_id: options.conversationId } : {}),
      busy: false,
      turn_count: 0,
      queued: [],
      warnings: [...options.warnings],
    },
    blocks: [],
  };
}

export function projectChatState(model: DoctorModel): ChatState {
  const meta = model.meta;
  const items = model.blocks.map(projectBlock);
  const activeTools = model.blocks.filter(
    (block): block is ToolBlock => block.type === "tool" && block.status === "in_progress",
  );
  const error = meta.error;

  return {
    timeline: {
      items,
      showThoughts: true,
    },
    composer: {
      busy: meta.busy,
      placeholder: "描述现场现象（/help 查看命令）",
    },
    queue: {
      items: meta.queued.map((item) => ({ ...item, tag: "queued" })),
    },
    activity: {
      items: activeTools.length
        ? activeTools.map((tool) => ({
            id: tool.id,
            author: "doctor",
            label: toolTitle(tool),
            hint: "Esc to interrupt",
          }))
        : [{
            id: "agent",
            author: "doctor",
            label: meta.busy ? `${meta.mode} agent · working…` : `${meta.mode} agent`,
            ...(meta.busy ? { hint: "Esc to interrupt" } : {}),
          }],
    },
    footer: {
      text: footerText(meta),
      toast: error
        ? { text: error.message, tone: "error" }
        : meta.warnings[0]
          ? { text: meta.warnings[0], tone: "warning" }
          : null,
    },
    sidecar: undefined,
  };
}

function projectBlock(block: DoctorBlock): TranscriptItem {
  if (block.type === "message") {
    return {
      type: "message",
      id: block.id,
      role: block.role,
      author: block.role === "user" ? "you" : "doctor",
      text: block.content,
      format: block.role === "agent" ? "markdown" : "plain",
      streaming: block.streaming,
    };
  }
  if (block.type === "tool") {
    const command = bashCommand(block);
    const lines = block.result ? block.result.split("\n") : [];
    const content = [
      ...(command ? [{ type: "command" as const, command }] : []),
      ...(lines.length ? [{ type: "output" as const, lines }] : []),
    ];
    return {
      type: "block",
      id: block.id,
      kind: "tool",
      author: "doctor",
      title: toolTitle(block),
      status: block.status,
      content: content.length ? content : undefined,
    };
  }
  if (block.type === "thought") {
    return {
      type: "block",
      id: block.id,
      kind: "thought",
      author: "doctor",
      title: "Thinking",
      status: block.status,
      content: block.content ? { type: "text", text: block.content } : undefined,
    };
  }
  return {
    type: "block",
    id: block.id,
    kind: "info",
    title: block.content,
    status: block.tone === "error" ? "failed" : "completed",
    tone: block.tone === "warn" ? "warning" : undefined,
  };
}

function bashCommand(block: ToolBlock): string | undefined {
  if (block.tool_name !== "bash" || !block.args || typeof block.args !== "object") return undefined;
  const command = (block.args as { command?: unknown }).command;
  return typeof command === "string" && command.trim() ? command : undefined;
}

function toolTitle(block: ToolBlock): string {
  const command = bashCommand(block);
  const firstLine = command?.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
  const preview = firstLine ? ` · ${firstLine.length > 96 ? `${firstLine.slice(0, 95)}…` : firstLine}` : "";
  const duration = block.duration_ms === undefined ? "" : ` · ${block.duration_ms}ms`;
  const truncated = block.truncated ? " · truncated" : "";
  const timeout = block.timeout_ms === undefined ? "" : ` · timeout ${block.timeout_ms}ms`;
  return `${block.tool_name}${preview}${duration}${truncated}${timeout}`;
}

function footerText(meta: DoctorMeta): string {
  const target = meta.mode === "server"
    ? `server ${meta.server ?? "?"}`
    : `local ${meta.model ?? "?"}`;
  const conversation = meta.conversation_id ? ` · conversation ${short(meta.conversation_id)}` : "";
  return `${target}${conversation} · Ctrl+C exit · Esc interrupt`;
}

function short(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}
