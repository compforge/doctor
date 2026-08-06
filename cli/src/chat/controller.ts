import {
  createChatStore,
  type ChatProtocol,
  type CommandSpec,
  type InteractionResponse,
} from "chat-tui";

import { DOCTOR_CLI_VERSION } from "../app/version";
import { projectChatState } from "./model";
import { Session } from "./session";

export const CHAT_COMMANDS: readonly CommandSpec[] = [
  { name: "help", description: "Show keyboard and command help" },
  { name: "exit", description: "Exit Doctor chat" },
];

export class Controller implements ChatProtocol {
  readonly stateStore;
  private readonly history: string[] = [];
  private historyIndex = 0;
  private historyDraft = "";
  private unsubscribe: () => void;

  constructor(
    private readonly session: Session,
    private readonly onExit: () => void | Promise<void>,
  ) {
    this.stateStore = createChatStore(projectChatState(session.getModel(), DOCTOR_CLI_VERSION));
    this.unsubscribe = session.subscribe((model) => {
      this.stateStore.commit(projectChatState(model, DOCTOR_CLI_VERSION));
    });
  }

  async submit(text: string): Promise<void> {
    this.history.push(text);
    this.historyIndex = this.history.length;
    this.historyDraft = "";
    await this.session.submit(text);
  }

  async command(name: string): Promise<void> {
    if (name === "exit") {
      await this.exit();
      return;
    }
    if (name === "help") {
      this.stateStore.commit({
        footer: {
          ...this.stateStore.getState("footer"),
          toast: {
            text: "Enter 发送 · Ctrl+J 换行 · Esc 中断 · Ctrl+O 展开工具输出 · Ctrl+C 两次退出",
            tone: "info",
          },
        },
      });
    }
  }

  cancel(): void {
    this.session.abort();
  }

  async exit(): Promise<void> {
    await this.onExit();
  }

  resolvePicker(): void {}
  searchPicker(): void {}
  resolveInteraction(_id: string, _response: InteractionResponse): void {}

  recallQueued(): { text: string } | null {
    return this.session.recallQueued();
  }

  historyPrev(current: string): { text: string } | null {
    if (!this.history.length || this.historyIndex === 0) return null;
    if (this.historyIndex === this.history.length) this.historyDraft = current;
    this.historyIndex -= 1;
    return { text: this.history[this.historyIndex]! };
  }

  historyNext(): { text: string } | null {
    if (this.historyIndex >= this.history.length) return null;
    this.historyIndex += 1;
    return {
      text: this.historyIndex === this.history.length
        ? this.historyDraft
        : this.history[this.historyIndex]!,
    };
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    await this.session.dispose();
  }
}
