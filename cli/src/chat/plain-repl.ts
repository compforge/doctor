import { createInterface } from "node:readline/promises";

import type { DoctorModel } from "./model";
import type { Session, RestartChat } from "./session";
import { sessionLabel } from "./history";

type Write = (text: string) => void;

/** Render model updates incrementally for runtimes that cannot load OpenTUI's native FFI backend. */
export class PlainChatRenderer {
  private readonly messageText = new Map<string, string>();
  private readonly finalizedMessages = new Set<string>();
  private readonly toolStatus = new Map<string, string>();
  private readonly infoBlocks = new Map<string, string>();
  private errorMessage?: string;

  constructor(private readonly write: Write) {}

  render(model: DoctorModel, replay = false): void {
    for (const block of model.blocks) {
      if (block.type === "message" && (block.role === "agent" || replay)) {
        this.renderMessage(block.id, block.content, block.streaming === true, block.role);
      } else if (block.type === "tool") {
        const previous = this.toolStatus.get(block.id);
        if (previous !== block.status) {
          const duration = block.duration_ms === undefined ? "" : ` · ${block.duration_ms}ms`;
          this.write(`\n[tool] ${block.tool_name}: ${block.status}${duration}\n`);
          this.toolStatus.set(block.id, block.status);
        }
      } else if (block.type === "info" && this.infoBlocks.get(block.id) !== block.content) {
        this.write(`\n[${block.tone}] ${block.content}\n`);
        this.infoBlocks.set(block.id, block.content);
      }
    }

    const error = model.meta.error?.message;
    if (error && error !== this.errorMessage) {
      this.write(`\n[error] ${error}\n`);
      this.errorMessage = error;
    } else if (!error) {
      this.errorMessage = undefined;
    }
  }

  private renderMessage(id: string, content: string, streaming: boolean, role: "user" | "agent"): void {
    const previous = this.messageText.get(id);
    if (previous === undefined) {
      this.write(`\n${role === "user" ? "you" : "doctor"}> ${content}`);
    } else if (content.startsWith(previous)) {
      this.write(content.slice(previous.length));
    } else if (content !== previous) {
      this.write(`\n${role === "user" ? "you" : "doctor"}> ${content}`);
    }
    this.messageText.set(id, content);

    if (!streaming && !this.finalizedMessages.has(id)) {
      this.write("\n");
      this.finalizedMessages.add(id);
    }
  }
}

export async function runPlainRepl(session: Session, onRestart?: RestartChat): Promise<void> {
  const output = process.stdout;
  const input = process.stdin;
  const renderer = new PlainChatRenderer((text) => output.write(text));
  const readline = createInterface({ input, output, terminal: true });
  let closed = false;
  let busy = false;

  output.write("兼容终端模式：Enter 发送 · /help 查看命令 · /exit 退出 · Ctrl+C 中断\n");
  renderer.render(session.getModel(), true);
  const unsubscribe = session.subscribe((model) => renderer.render(model));
  const close = () => {
    closed = true;
    session.abort();
    readline.close();
  };
  const onSigterm = () => close();
  readline.on("SIGINT", () => {
    if (busy) {
      session.abort();
      output.write("\n[interrupt] 已请求中断当前问诊\n");
    } else {
      close();
    }
  });
  process.once("SIGTERM", onSigterm);

  try {
    while (!closed) {
      let text: string;
      try {
        text = (await readline.question("you> ")).trim();
      } catch {
        break;
      }
      if (!text) continue;
      if (text === "/exit") break;
      if (text.startsWith("/")) {
        const [name, ...parts] = text.slice(1).split(/\s+/);
        const argument = parts.join(" ");
        try {
          if (name === "help") output.write("/compact [说明] 压缩上下文\n/session 查看会话文件与统计\n/export [file.html|file.jsonl] 导出\n/resume [ID] 恢复会话\n/new 新会话\n/exit 退出\nCtrl+C 中断当前问诊；空闲时退出\n");
          else if (name === "compact") {
            busy = true;
            try { await session.compact(argument || undefined); } finally { busy = false; }
          }
          else if (name === "session") output.write(`${await session.sessionInfo()}\n`);
          else if (name === "export") output.write(`已导出：${await session.export(argument)}\n`);
          else if (name === "new" || name === "resume") {
            session.assertCanSwitch();
            if (!onRestart) throw new Error("当前宿主不支持切换会话");
            let selected = argument;
            if (name === "resume" && !selected) {
              const sessions = await session.historyStore!.list();
              if (!sessions.length) throw new Error("当前目录没有可恢复的会话");
              sessions.forEach((item, index) => output.write(`${index + 1}) ${sessionLabel(item)}\n`));
              const answer = (await readline.question("选择会话（序号，q 取消）：")).trim();
              if (answer === "q") continue;
              const target = sessions[Number(answer) - 1];
              if (!target) throw new Error("无效的会话序号");
              selected = target.path;
            }
            if (name === "resume") selected = (await session.historyStore!.resolve(selected)).path;
            await onRestart(name === "new" ? {} : { session: selected });
            break;
          } else output.write(`未知命令 /${name}；输入 /help 查看帮助\n`);
        } catch (error) { output.write(`[error] ${error instanceof Error ? error.message : String(error)}\n`); }
        continue;
      }
      busy = true;
      try {
        await session.submit(text);
      } finally {
        busy = false;
      }
    }
  } finally {
    process.off("SIGTERM", onSigterm);
    unsubscribe();
    readline.close();
    await session.dispose();
  }
}
