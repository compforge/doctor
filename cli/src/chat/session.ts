import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { AgentSource, MessageBlock } from "@compforge/doctor-agent";
import {
  PatchEmitter,
  applyPatch,
  type PatchEvent,
} from "@compforge/agentue/ui";

import { reportError } from "../app/error-report";
import { mapErrorMessage } from "../protocol";
import type { DoctorModel, QueuedPrompt } from "./model";
import { exportChat, type ChatHistory, type ChatHistoryStore } from "./history";

export interface ChatRestart { session?: string }
export type RestartChat = (request: ChatRestart) => void | Promise<void>;

export class Session {
  private model: DoctorModel;
  private readonly emitter = new PatchEmitter();
  private readonly listeners = new Set<(model: DoctorModel) => void>();
  private busy = false;
  private disposed = false;
  private queue: QueuedPrompt[] = [];
  private draining?: Promise<void>;

  constructor(
    initialModel: DoctorModel,
    private readonly agent: AgentSource,
    private readonly pluginIdentity?: string,
    readonly history?: ChatHistory,
    readonly historyStore?: ChatHistoryStore,
  ) {
    this.model = initialModel;
  }

  getModel(): DoctorModel {
    return this.model;
  }

  subscribe(listener: (model: DoctorModel) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  submit(text: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Session is disposed"));
    if (this.busy) {
      this.queue.push({ id: `queued-${crypto.randomUUID()}`, text });
      this.publishQueue();
      return Promise.resolve();
    }
    this.draining = this.drain(text);
    return this.draining;
  }

  async sessionInfo(): Promise<string> {
    if (!this.history) return this.model.meta.mode === "server"
      ? `远端会话：${this.model.meta.conversation_id ?? "尚未创建"}` : "临时会话：不保存聊天记录";
    const stats = await this.history.session.getStats(BACKGROUND_CONTEXT);
    return `会话：${this.history.metadata.id}\n文件：${this.history.metadata.path}\n消息：${stats.messageCount} · Tokens：${stats.usage.totalTokens} · Cost：${stats.usage.cost.total}`;
  }

  async compact(instructions?: string): Promise<void> {
    this.assertCanSwitch();
    if (!this.agent.compact) throw new Error("当前 Agent 不支持压缩上下文");
    if (this.disposed) throw new Error("Session is disposed");
    this.draining = this.runCompaction(instructions);
    await this.draining;
  }

  private async runCompaction(instructions?: string): Promise<void> {
    this.busy = true;
    this.accept(this.emitter.start(this.model));
    this.accept(this.emitter.metaSet("meta.busy", { busy: true }));
    try {
      for await (const event of this.agent.compact!(instructions, { emitter: this.emitter })) this.accept(event);
    } finally {
      this.busy = false;
      // Also clear on stream failure, which may arrive without compaction_end.
      this.accept(this.emitter.metaSet("meta.compacting", { compacting: false }));
      this.accept(this.emitter.metaSet("meta.busy", { busy: false }));
      this.accept(this.emitter.end());
      const next = this.disposed ? undefined : this.queue.shift();
      this.publishQueue();
      if (next) await this.drain(next.text);
      this.draining = undefined;
    }
  }

  async export(path?: string): Promise<string> {
    if (this.busy) throw new Error("请等待当前回复结束或中断后再导出");
    if (!this.history) throw new Error("当前没有本地会话文件；远端或 --no-session 会话不支持此导出");
    return exportChat(this.history, path);
  }

  assertCanSwitch(): void {
    if (this.model.meta.mode !== "local") throw new Error("远端会话请退出后使用 --server --resume");
    if (this.busy) throw new Error("请等待当前回复结束或中断后再切换会话");
  }

  abort(): void {
    if (!this.busy) return;
    this.agent.abort();
  }

  recallQueued(): { text: string } | null {
    const item = this.queue.pop();
    if (!item) return null;
    this.publishQueue();
    return { text: item.text };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.queue = [];
    this.publishQueue();
    this.abort();
    await this.draining?.catch(() => undefined);
    await this.agent.dispose();
  }

  private async drain(first: string): Promise<void> {
    try {
      let text: string | undefined = first;
      while (text !== undefined && !this.disposed) {
        await this.runTurn(text);
        const next = this.disposed ? undefined : this.queue.shift();
        this.publishQueue();
        text = next?.text;
      }
    } finally {
      this.draining = undefined;
    }
  }

  private async runTurn(text: string): Promise<void> {
    this.busy = true;
    this.accept(this.emitter.start(this.model));
    this.accept(this.emitter.metaSet("meta.error", { error: null }));
    this.accept(this.emitter.metaSet("meta.busy", { busy: true }));
    this.accept(this.emitter.metaSet("meta.turn_count", {
      turn_count: this.model.meta.turn_count + 1,
    }));
    this.accept(this.emitter.blockSet({
      id: `user-${crypto.randomUUID()}`,
      type: "message",
      role: "user",
      content: text,
      streaming: false,
    } satisfies MessageBlock));

    try {
      for await (const event of this.agent.run(text, { emitter: this.emitter })) {
        this.accept(event);
      }
    } catch (error) {
      reportError(error, { context: "doctor chat/turn", plugin: this.pluginIdentity,
        displayMessage: mapErrorMessage(error) });
      this.accept(this.emitter.error("agent_error", mapErrorMessage(error)));
    } finally {
      this.busy = false;
      // Also clear on stream failure, which may arrive without compaction_end.
      this.accept(this.emitter.metaSet("meta.compacting", { compacting: false }));
      this.accept(this.emitter.metaSet("meta.busy", { busy: false }));
      this.accept(this.emitter.end());
    }
  }

  private publishQueue(): void {
    this.accept(this.emitter.metaSet("meta.queued", {
      queued: this.queue.map((item) => ({ ...item })),
    }));
  }

  private accept(event: PatchEvent): void {
    this.model = applyPatch(this.model, event) as DoctorModel;
    for (const listener of this.listeners) listener(this.model);
  }
}
