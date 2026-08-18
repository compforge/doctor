import { createInterface } from "node:readline/promises";

import { DOCTOR_CLI_VERSION } from "../app/version";
import { renderBanner } from "./banner";
import type { DoctorModel } from "./model";
import type { Session } from "./session";

type Write = (text: string) => void;

/** Render model updates incrementally for runtimes that cannot load OpenTUI's native FFI backend. */
export class PlainChatRenderer {
  private readonly messageText = new Map<string, string>();
  private readonly finalizedMessages = new Set<string>();
  private readonly toolStatus = new Map<string, string>();
  private readonly infoBlocks = new Set<string>();
  private errorMessage?: string;

  constructor(private readonly write: Write) {}

  render(model: DoctorModel): void {
    for (const block of model.blocks) {
      if (block.type === "message" && block.role === "agent") {
        this.renderMessage(block.id, block.content, block.streaming === true);
      } else if (block.type === "tool") {
        const previous = this.toolStatus.get(block.id);
        if (previous !== block.status) {
          const duration = block.duration_ms === undefined ? "" : ` · ${block.duration_ms}ms`;
          this.write(`\n[tool] ${block.tool_name}: ${block.status}${duration}\n`);
          this.toolStatus.set(block.id, block.status);
        }
      } else if (block.type === "info" && !this.infoBlocks.has(block.id)) {
        this.write(`\n[${block.tone}] ${block.content}\n`);
        this.infoBlocks.add(block.id);
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

  private renderMessage(id: string, content: string, streaming: boolean): void {
    const previous = this.messageText.get(id);
    if (previous === undefined) {
      this.write(`\ndoctor> ${content}`);
    } else if (content.startsWith(previous)) {
      this.write(content.slice(previous.length));
    } else if (content !== previous) {
      this.write(`\ndoctor> ${content}`);
    }
    this.messageText.set(id, content);

    if (!streaming && !this.finalizedMessages.has(id)) {
      this.write("\n");
      this.finalizedMessages.add(id);
    }
  }
}

export async function runPlainRepl(session: Session): Promise<void> {
  const output = process.stdout;
  const input = process.stdin;
  const renderer = new PlainChatRenderer((text) => output.write(text));
  const readline = createInterface({ input, output, terminal: true });
  let closed = false;
  let busy = false;

  output.write(`${renderBanner({ version: DOCTOR_CLI_VERSION, meta: session.getModel().meta })}\n`);
  output.write("兼容终端模式：Enter 发送 · /help 查看命令 · /exit 退出 · Ctrl+C 中断\n");
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
      if (text === "/help") {
        output.write("/help  显示帮助\n/exit  退出 Doctor chat\nCtrl+C 中断当前问诊；空闲时退出\n");
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
