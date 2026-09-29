import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import {
  buildSessionContext,
  JsonlSessionRepo,
  type AgentMessage,
  type JsonlSessionMetadata,
  type Session as PiSession,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentBlock } from "@compforge/doctor-agent";
import type { CliFlags } from "../protocol";
import { escapeHtml } from "../collect/output/report/components/content";
import { isInteractive } from "../terminal/policy";
import { printNumberedChoices, promptListedChoice, matchListedChoice } from "../terminal/selection";

export interface ChatHistory {
  session: PiSession<JsonlSessionMetadata>;
  metadata: JsonlSessionMetadata;
  messages: AgentMessage[];
}

/** The host chooses storage and identity; Pi owns the append-only file format and context reconstruction. */
export class ChatHistoryStore {
  readonly repo: JsonlSessionRepo;
  constructor(readonly cwd = process.cwd(), sessionsRoot = join(process.env.DOCTOR_HOME ?? join(homedir(), ".doctor"), "sessions")) {
    this.repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd }), sessionsRoot });
  }

  async list(): Promise<JsonlSessionMetadata[]> {
    return (await this.repo.list({ cwd: this.cwd }))
      .filter((item) => item.metadata?.doctor === true)
      .sort((a, b) => b.modifiedAt - a.modifiedAt || b.createdAt - a.createdAt);
  }

  async prepare(flags: CliFlags, identity: { profile: string; plugin: string }): Promise<ChatHistory | undefined> {
    validateSessionFlags(flags);
    if (flags.noSession) return undefined;
    let metadata: JsonlSessionMetadata | undefined;
    const selector = flags.session ?? (typeof flags.resume === "string" ? flags.resume : undefined);
    if (selector) metadata = await this.resolve(selector);
    else if (flags.continue) metadata = (await this.list())[0];
    else if (flags.resume) {
      const choices = await this.list();
      if (!choices.length) throw new Error("当前目录没有可恢复的 Doctor 会话");
      if (!isInteractive()) throw new Error("选择会话需要交互终端；请使用 --session <路径或ID>");
      printNumberedChoices(choices, "[chat] 选择历史会话：", sessionLabel);
      metadata = await promptListedChoice({
        question: "选择会话（序号或ID，q 取消）：",
        match: (answer) => matchListedChoice(choices, answer, (item) => item.id, (item) => item),
        invalidMessage: "请输入列表中的序号或完整会话 ID。",
      });
      if (!metadata) throw new Error("已取消恢复会话");
    }
    if (metadata) {
      if (metadata.metadata?.doctor !== true) throw new Error("所选文件不是 Doctor Chat 会话");
      if (metadata.metadata.profile !== identity.profile) {
        throw new Error(`会话属于 profile '${metadata.metadata.profile}'；请使用 --profile 指定该环境`);
      }
      if (metadata.metadata.plugin !== identity.plugin) {
        throw new Error("会话的 Plugin 版本与当前版本不同；请使用原版本或新建会话");
      }
      if (resolve(metadata.cwd) !== resolve(this.cwd)) {
        throw new Error(`会话工作目录是 ${metadata.cwd}；请在该目录恢复`);
      }
    }
    const session = metadata ? await this.repo.open(metadata) : await this.repo.create({
      cwd: this.cwd, metadata: { doctor: true, ...identity },
    });
    metadata = await session.getMetadata();
    // Chat artifacts contain request/tool content; do not inherit a world-readable umask.
    await chmod(metadata.path, 0o600);
    const entries = await session.findEntriesOnBranch({ order: "oldestFirst" });
    return { session, metadata, messages: buildSessionContext(entries).messages };
  }

  async resolve(selector: string): Promise<JsonlSessionMetadata> {
    if (selector.endsWith(".jsonl") || selector.includes("/")) {
      const path = resolve(selector.startsWith("~/") ? join(homedir(), selector.slice(2)) : selector);
      // The public Pi opener accepts metadata rather than a path. Read only its header
      // here; repo.open validates the file and reconstructs its native entries.
      const header = JSON.parse((await readFile(path, "utf8")).split("\n", 1)[0]!);
      if (header.kind !== "header" || header.version !== 4 || typeof header.id !== "string" || typeof header.cwd !== "string") {
        throw new Error("不支持的 Doctor 会话文件；需要 Pi JSONL v4");
      }
      return { id: header.id, cwd: header.cwd, createdAt: header.createdAt,
        modifiedAt: header.createdAt, path, sourceFormat: 4, metadata: header.metadata };
    }
    const matches = (await this.list()).filter((item) => item.id.startsWith(selector));
    if (matches.length !== 1) throw new Error(matches.length ? "会话 ID 前缀不唯一" : `未找到会话：${selector}`);
    return matches[0]!;
  }
}

export function validateSessionFlags(flags: CliFlags): void {
  const selectors = [flags.continue, flags.resume, flags.session].filter(Boolean);
  if (selectors.length > 1) throw new Error("--continue、--resume、--session 只能指定一个");
  if (flags.noSession && selectors.length) throw new Error("--no-session 不能与会话恢复参数一起使用");
  if (flags.server && (flags.continue || flags.session || flags.noSession || flags.sessionDir)) {
    throw new Error("--server 只支持远端 --resume；本地会话参数不能用于远端 chat");
  }
}

export function sessionLabel(item: JsonlSessionMetadata): string {
  return `${new Date(item.modifiedAt).toLocaleString()}  ${item.id}  profile=${item.metadata?.profile ?? "?"}`;
}

export function historyBlocks(messages: readonly AgentMessage[]): AgentBlock[] {
  const blocks: AgentBlock[] = [];
  for (const [index, message] of messages.entries()) {
    const id = `history-${index}`;
    if (message.role === "user") {
      blocks.push({ id, type: "message", role: "user", content: typeof message.content === "string"
        ? message.content : message.content.map((part) => part.type === "text" ? part.text : "[image]").join("\n") });
    } else if (message.role === "assistant") {
      for (const [partIndex, part] of message.content.entries()) {
        if (part.type === "text") blocks.push({ id: `${id}-${partIndex}`, type: "message", role: "agent", content: part.text });
        else if (part.type === "thinking") blocks.push({ id: `${id}-${partIndex}`, type: "thought", content: part.thinking, status: "completed" });
        else if (part.type === "toolCall") blocks.push({ id: part.id, type: "tool", tool_name: part.name, args: part.arguments,
          status: "failed", result: "未记录工具结果（可能在执行时中断）" });
      }
    } else if (message.role === "toolResult") {
      const existing = blocks.find((block) => block.type === "tool" && block.id === message.toolCallId);
      const result = message.content.map((part) => part.type === "text" ? part.text : "[image]").join("\n");
      if (existing?.type === "tool") Object.assign(existing, { result, status: message.isError ? "failed" : "completed" });
      else blocks.push({ id: message.toolCallId, type: "tool", tool_name: message.toolName,
        result, status: message.isError ? "failed" : "completed" });
    }
  }
  return blocks;
}

export async function exportChat(history: ChatHistory, requestedPath?: string): Promise<string> {
  const path = resolve(requestedPath?.trim() || `doctor-chat-${history.metadata.id}.html`);
  const extension = extname(path).toLowerCase();
  if (extension === ".jsonl") {
    await copyFile(history.metadata.path, path, constants.COPYFILE_EXCL);
    await chmod(path, 0o600);
  } else if (extension === ".html") {
    const entries = await history.session.findEntriesOnBranch({ order: "oldestFirst" });
    const messages = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
    const blocks = historyBlocks(messages);
    const content = blocks.map((block) => {
      const title = block.type === "message" ? block.role === "user" ? "You" : "Doctor"
        : block.type === "tool" ? `${block.tool_name} · ${block.status}` : block.type === "thought" ? "Thinking" : "Info";
      const body = block.type === "tool" ? `${JSON.stringify(block.args ?? {}, null, 2)}\n\n${block.result ?? ""}` : block.content;
      return `<section><h2>${escapeHtml(title)}</h2><pre>${escapeHtml(body)}</pre></section>`;
    }).join("\n");
    await writeFile(path, `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Doctor Chat ${escapeHtml(history.metadata.id)}</title><style>body{max-width:960px;margin:32px auto;padding:0 20px;font-family:system-ui}section{border-top:1px solid #ddd;padding:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 monospace}h2{font-size:16px}</style>
<h1>Doctor Chat</h1><p>${escapeHtml(history.metadata.id)}</p>${content}</html>`, { flag: "wx", mode: 0o600 });
  } else throw new Error("导出文件需使用 .html 或 .jsonl 扩展名");
  return path;
}
