import type {
  AgentSource,
  InfoBlock,
  MessageBlock,
  RunContext,
  ToolBlock,
} from "@compforge/doctor-agent";
import type { PatchEvent } from "@compforge/agentue/ui";
import stripAnsi from "strip-ansi";

import { profileToUpload } from "../app/config/config";
import type { Profile } from "../app/config/model";
import { recordConversation, saveState } from "../app/config/state";
import type { AgentEventBase, State } from "../protocol";
import { DoctorClient, ServerError, mapErrorMessage } from "../protocol";

export type ServerClient = Pick<
  DoctorClient,
  "createConnection" | "deleteConnection" | "streamMessage"
>;

export interface ServerAgentOptions {
  client: ServerClient;
  connectionId: string;
  conversationId?: string;
  profileName: string;
  profile: Profile;
  state: State;
  statePath: string;
  verbose?: boolean;
}

/** Compatibility adapter for the existing Python doctor-server event stream. */
export class ServerAgent implements AgentSource {
  private readonly client: ServerClient;
  private connectionId: string;
  private conversationId?: string;
  private persistedState: State;
  private currentAbort?: AbortController;

  constructor(private readonly options: ServerAgentOptions) {
    this.client = options.client;
    this.connectionId = options.connectionId;
    this.conversationId = options.conversationId;
    this.persistedState = options.state;
  }

  async *run(text: string, context: RunContext): AsyncIterable<PatchEvent> {
    const ac = new AbortController();
    this.currentAbort = ac;
    let assistantId: string | undefined;
    let assistantText = "";
    const toolFinished = new Set<string>();
    const toolStartTime = new Map<string, number>();

    try {
      for await (const event of this.streamWithRetry(text, ac.signal)) {
        switch (event.event_type) {
          case "session.created":
          case "session.attached":
            this.conversationId = event.session_id;
            this.persistedState = recordConversation(
              this.persistedState,
              event.session_id,
              this.options.profileName,
            );
            yield context.emitter.metaSet(
              "meta.conversation_id",
              { conversation_id: event.session_id },
              { eventType: event.event_type },
            );
            break;
          case "text.chunk": {
            const chunk = String(event.content ?? "");
            if (!assistantId) {
              assistantId = `assistant-${crypto.randomUUID()}`;
              yield context.emitter.blockSet({
                id: assistantId,
                type: "message",
                role: "agent",
                content: "",
                streaming: true,
              } satisfies MessageBlock, { eventType: event.event_type });
            }
            assistantText += chunk;
            yield context.emitter.blockAppend(
              { id: assistantId, type: "message", content: chunk },
              { mask: "block.content", eventType: event.event_type },
            );
            break;
          }
          case "thinking.chunk":
            if (this.options.verbose) {
              yield context.emitter.blockSet({
                id: `thinking-${event.run_id ?? "run"}`,
                type: "info",
                tone: "muted",
                content: String(event.content ?? ""),
              } satisfies InfoBlock, { eventType: event.event_type });
            }
            break;
          case "tool_call.started": {
            const id = String(event.tool_call_id ?? crypto.randomUUID());
            const occurredAt = Number(event.occurred_at);
            if (Number.isFinite(occurredAt)) toolStartTime.set(id, occurredAt);
            yield context.emitter.blockSet({
              id,
              type: "tool",
              tool_name: String(event.tool_name ?? "tool"),
              status: "in_progress",
              args: event.args,
            } satisfies ToolBlock, { eventType: event.event_type });
            break;
          }
          case "tool_call.result":
          case "tool_call.completed": {
            const id = String(event.tool_call_id ?? "");
            if (!id || toolFinished.has(id)) break;
            toolFinished.add(id);
            const status = String(event.status ?? "completed").toLowerCase();
            const start = toolStartTime.get(id);
            const end = Number(event.occurred_at);
            const duration = start !== undefined && Number.isFinite(end) && end >= start
              ? end - start
              : undefined;
            yield context.emitter.blockSet({
              id,
              type: "tool",
              tool_name: String(event.tool_name ?? "tool"),
              status: status === "completed" ? "completed" : "failed",
              result: stripAnsi(String(event.display_content ?? event.content ?? "")),
              ...(duration === undefined ? {} : { duration_ms: duration }),
              ...(event.truncated === true ? { truncated: true } : {}),
              ...(typeof event.timeout_ms === "number" ? { timeout_ms: event.timeout_ms } : {}),
            } satisfies ToolBlock, { eventType: event.event_type });
            break;
          }
          case "run.completed":
            if (assistantId) {
              yield context.emitter.blockSet({
                id: assistantId,
                type: "message",
                role: "agent",
                content: assistantText,
                streaming: false,
              } satisfies MessageBlock, { eventType: event.event_type });
            }
            saveState(this.options.statePath, this.persistedState);
            break;
        }
      }
    } catch (error) {
      if (ac.signal.aborted) {
        if (assistantId) {
          yield context.emitter.blockSet({
            id: assistantId,
            type: "message",
            role: "agent",
            content: `${assistantText}\n\n[已中断]`,
            streaming: false,
          } satisfies MessageBlock);
        }
        yield context.emitter.blockSet({
          id: `info-${crypto.randomUUID()}`,
          type: "info",
          tone: "warn",
          content: "已中断当前 turn；server 端已经开始的工具可能仍会完成。",
        } satisfies InfoBlock);
      } else {
        throw new Error(mapErrorMessage(error));
      }
    } finally {
      if (this.currentAbort === ac) this.currentAbort = undefined;
    }
  }

  abort(): void {
    this.currentAbort?.abort();
  }

  async dispose(): Promise<void> {
    this.abort();
    try {
      await this.client.deleteConnection(this.connectionId);
    } catch {
      // Connection cleanup is best-effort during terminal shutdown.
    }
    saveState(this.options.statePath, this.persistedState);
  }

  private async *streamWithRetry(
    text: string,
    signal: AbortSignal,
    retry = true,
  ): AsyncGenerator<AgentEventBase> {
    try {
      yield* this.client.streamMessage(this.connectionId, {
        text,
        conversation_id: this.conversationId,
      }, signal);
    } catch (error) {
      if (retry && error instanceof ServerError && error.code === "connection_not_found") {
        this.connectionId = await this.client.createConnection(profileToUpload(this.options.profile));
        yield* this.streamWithRetry(text, signal, false);
        return;
      }
      throw error;
    }
  }
}
