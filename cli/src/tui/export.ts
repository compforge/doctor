// /export 命令：把当前对话总结成本地 markdown 报告。
//
// 设计参考 plan: ~/.claude/plans/export-llm-server-llm-smooth-fountain.md
//
// 思路：CLI 端拼一段 summarize prompt 走普通 chat 流，server 自动用 conversation_id
// 把历史 + 这条 prompt 喂 LLM，回流一段结构化 markdown。CLI 这边只负责发起、收尾、
// 拼 metadata 头、落盘。server 一行不动。
//
// 已知副作用：summarize prompt + 报告会被 harness session store 持久化进 transcript，
// 下次 --resume 时 LLM 上下文里能看到。v0 接受这点，文件头与 /help 都做了提示。

import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export const EXPORT_PROMPT = `请基于上述对话，把刚才的诊断过程整理为一份结构化的 markdown 报告，包含以下章节：

## 问题
- 用户最初要排查什么（一句话）

## 关键证据
- 调用了哪些工具，关键发现是什么（按时序）
- 引用具体数据（pod 名 / message_id / 错误码 / 时间戳等），不要泛泛而谈

## 初步结论
- 当前判断的根因 / 范围；如果证据不足，明确说"尚未定位"并指出缺哪些信息

## 建议动作
- 下一步应该做什么（验证 / 修复 / 升级）

不要重复对话原文；用自己的话提炼。如果某节信息不足，写"（无）"。`;

export interface ExportMeta {
  conversationId?: string;
  profileName: string;
  serverUrl: string;
  readonly: boolean;
  modelTag: string;
  cliVersion: string;
}

export function buildHeader(meta: ExportMeta, exportedAt: Date = new Date()): string {
  const conv = meta.conversationId ?? "(none)";
  return [
    "<!-- doctor export v1 -->",
    `- conversation: ${conv}`,
    `- profile: ${meta.profileName} (server=${meta.serverUrl}, readonly=${meta.readonly})`,
    `- model: ${meta.modelTag}`,
    `- exported_at: ${exportedAt.toISOString()}`,
    `- cli_version: ${meta.cliVersion}`,
    "- 注：本报告由 LLM 基于对话历史总结生成；详细 transcript 未导出",
    "- 已知行为：本次 /export 请求会在 conversation 里留一条记录，下次 --resume 时可见",
    "",
    "---",
    "",
    "",
  ].join("\n");
}

// yyyymmdd-HHMMSS local time（不含时区，文件名够用即可）
function timestampSuffix(now: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

export function defaultExportPath(conversationId: string | undefined, now: Date = new Date()): string {
  const convShort = conversationId ? conversationId.slice(0, 8) : "noconv";
  const file = `${convShort}-${timestampSuffix(now)}.md`;
  return resolve(homedir(), ".doctor", "exports", file);
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

// path 解析：~/ 展开 → 相对 → 绝对。相对路径相对 process.cwd（用户在终端里的当前目录）
export function resolveExportPath(input: string | undefined, conversationId: string | undefined, now: Date = new Date()): string {
  if (!input) return defaultExportPath(conversationId, now);
  const expanded = expandHome(input);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

export class ExportFileExistsError extends Error {
  constructor(public path: string) {
    super(`文件已存在：${path}`);
    this.name = "ExportFileExistsError";
  }
}

// 写文件：父目录不存在自动 mkdir -p；目标文件已存在则抛 ExportFileExistsError 让调用方决定怎么报错。
export async function writeExport(content: string, path: string): Promise<void> {
  try {
    await stat(path);
    throw new ExportFileExistsError(path);
  } catch (err) {
    if (err instanceof ExportFileExistsError) throw err;
    // ENOENT 才是预期路径——继续写
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
