import {
  createChatStore,
  type ChatProtocol,
  type CommandSpec,
  type InteractionResponse,
} from "chat-tui";

import { projectChatState } from "./model";
import { Session, type RestartChat } from "./session";
import { sessionLabel } from "./history";

export const CHAT_COMMANDS: readonly CommandSpec[] = [
  { name: "help", description: "Show keyboard and command help" },
  { name: "exit", description: "Exit Doctor chat" },
  { name: "compact", description: "压缩当前模型上下文，保留完整聊天记录" },
  { name: "session", description: "查看当前会话文件与统计" },
  { name: "export", description: "导出会话：/export [file.html 或 file.jsonl]" },
  { name: "resume", description: "选择本地历史会话" },
  { name: "new", description: "开始新会话" },
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
    private readonly onRestart?: RestartChat,
  ) {
    this.stateStore = createChatStore(projectChatState(session.getModel()));
    this.unsubscribe = session.subscribe((model) => {
      this.stateStore.commit(projectChatState(model));
    });
  }

  async submit(text: string): Promise<void> {
    this.history.push(text);
    this.historyIndex = this.history.length;
    this.historyDraft = "";
    await this.session.submit(text);
  }

  async command(name: string, argument = ""): Promise<void> {
    try {
      if (name === "compact") { await this.session.compact(argument || undefined); return; }
      if (name === "session") { this.toast(await this.session.sessionInfo()); return; }
      if (name === "export") { this.toast(`已导出：${await this.session.export(argument)}`); return; }
      if (name === "new" || name === "resume") {
        this.session.assertCanSwitch();
        if (!this.onRestart) throw new Error("当前宿主不支持切换会话");
        if (name === "new") { await this.onRestart({}); return; }
        if (argument.trim()) {
          const target = await this.session.historyStore!.resolve(argument.trim());
          await this.onRestart({ session: target.path });
          return;
        }
        const sessions = await this.session.historyStore!.list();
        if (!sessions.length) throw new Error("当前目录没有可恢复的会话");
        this.stateStore.commit({ composer: { ...this.stateStore.getState("composer"), picker: {
          id: "resume", title: "恢复会话", search: { mode: "local" },
          options: sessions.map((item) => ({ name: sessionLabel(item), description: item.path, value: item.path })),
        } } });
        return;
      }
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), "error");
      return;
    }
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

  resolvePicker(id: string, value: string | null): void {
    this.stateStore.commit({ composer: { ...this.stateStore.getState("composer"), picker: null } });
    if (id === "resume" && value) {
      void Promise.resolve(this.onRestart?.({ session: value })).catch((error: unknown) => {
        this.toast(error instanceof Error ? error.message : String(error), "error");
      });
    }
  }

  private toast(text: string, tone: "info" | "error" = "info"): void {
    this.stateStore.commit({ footer: { ...this.stateStore.getState("footer"), toast: { text, tone } } });
  }
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
