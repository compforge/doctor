import { terminalStdout } from "../../terminal/output";
import { prepareTerminalInput } from "../../terminal/input";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { McpServerDefinition, McpToolDefinition } from "@compforge/doctor-plugin";
import type { McpRuntimeTool } from "../../infra/mcp";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "../../terminal/selection";
import { describeMcpArg, parseMcpArgInput } from "./args";

export interface McpSelectionOptions {
  server?: string;
  tool?: string;
  args?: string;
  argsFile?: string;
}

function parseArgsJson(text: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${source} 必须是 JSON object`);
  return parsed as Record<string, unknown>;
}

export async function resolveToolArgs(opts: McpSelectionOptions, tool: McpToolDefinition): Promise<Record<string, unknown>> {
  if (opts.args && opts.argsFile) throw new Error("--args 与 --args-file 不能同时使用");
  if (opts.argsFile) return parseArgsJson(readFileSync(resolve(opts.argsFile), "utf-8"), "--args-file");
  if (opts.args) return parseArgsJson(opts.args, "--args");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const required = (tool.args ?? []).filter((arg) => arg.required && arg.default === undefined);
    if (required.length) throw new Error(`当前为非交互终端；请用 --args 提供必填参数：${required.map((arg) => arg.name).join(", ")}`);
    return {};
  }
  if (!tool.args?.length) {
    terminalStdout.write("[mcp] 该 tool 没有参数。\n");
    return {};
  }

  terminalStdout.write(`[mcp] 逐项填写 ${tool.name} 的参数；optional/default 参数可直接回车：\n`);
  prepareTerminalInput();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const values: Record<string, unknown> = {};
  try {
    for (const arg of tool.args) {
      while (true) {
        const answer = await readline.question(`[mcp] ${describeMcpArg(arg)}\n> `);
        try {
          const parsed = parseMcpArgInput(arg, answer);
          if (parsed.kind === "value") values[arg.name] = parsed.value;
          break;
        } catch (error) {
          terminalStdout.write(`[mcp] ${error instanceof Error ? error.message : String(error)}，请重新输入。\n`);
        }
      }
    }
    return values;
  } finally {
    readline.close();
  }
}

function findServers(choices: readonly McpServerDefinition[], query: string): McpServerDefinition[] {
  const needle = query.trim().toLowerCase();
  const exact = choices.filter((choice) => (
    choice.id.toLowerCase() === needle
    || choice.name.toLowerCase() === needle
    || `${choice.tenant}/${choice.name}`.toLowerCase() === needle
  ));
  if (exact.length) return exact;
  return choices.filter((choice) => choice.displayName.toLowerCase().includes(needle));
}

function findTools(tools: readonly McpToolDefinition[], query: string): McpToolDefinition[] {
  const needle = query.trim().toLowerCase();
  const exact = tools.filter((tool) => tool.name.toLowerCase() === needle);
  return exact.length ? exact : tools.filter((tool) => tool.name.toLowerCase().includes(needle));
}

export async function selectServer(
  choices: readonly McpServerDefinition[],
  query?: string,
): Promise<McpServerDefinition | undefined> {
  if (query) {
    const matched = findServers(choices, query);
    if (matched.length === 1) return matched[0];
    if (!matched.length) throw new Error(`找不到 MCP server：${query}`);
    throw new Error(`MCP server '${query}' 不唯一：${matched.map((item) => item.id).join(", ")}`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("当前为非交互终端；请显式指定 --server");
  printNumberedChoices(choices, "[mcp] 可用 MCP servers：", (choice) => choice.displayName);
  return promptListedChoice({
    question: "[mcp] 选择 server（序号或完整 tenant/name，q 退出）：",
    match: (answer) => matchListedChoice(choices, answer, (choice) => `${choice.tenant}/${choice.name}`, (choice) => choice),
    invalidMessage: "[mcp] 无效 server，请输入列表序号或完整 tenant/name。",
  });
}

export async function selectTool(
  tools: readonly McpToolDefinition[],
  runtimeTools: readonly McpRuntimeTool[],
  query?: string,
): Promise<McpToolDefinition | undefined> {
  if (query) {
    const matched = findTools(tools, query);
    if (matched.length === 1) return matched[0];
    if (!matched.length) throw new Error(`MCP 配置中找不到 tool：${query}`);
    throw new Error(`tool '${query}' 不唯一：${matched.map((item) => item.name).join(", ")}`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("当前为非交互终端；请显式指定 --tool");
  const live = new Set(runtimeTools.map((tool) => tool.name));
  printNumberedChoices(tools, "[mcp] server tools：", (tool) => `${tool.name} · runtime=${live.has(tool.name) ? "yes" : "no"}`);
  return promptListedChoice({
    question: "[mcp] 选择 tool（序号或名称，q 退出）：",
    match: (answer) => matchListedChoice(tools, answer, (tool) => tool.name, (tool) => tool),
    invalidMessage: "[mcp] 无效 tool，请输入列表序号或名称。",
  });
}
