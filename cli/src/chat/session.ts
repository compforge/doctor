import type { AgentSource, MessageBlock } from "@compforge/doctor-agent";
import {
  PatchEmitter,
  applyPatch,
  type PatchEvent,
} from "@compforge/agentue/ui";

import { mapErrorMessage } from "../protocol";
import type { DoctorModel, QueuedPrompt } from "./model";

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
      this.accept(this.emitter.error("agent_error", mapErrorMessage(error)));
    } finally {
      this.busy = false;
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
