import { createInterface } from "node:readline/promises";
import { currentCommandSignal } from "../command/execution-scope";
import { CommandInputError } from "../command";
import { withTerminalInput } from "./interaction";
import { terminalOutputStream } from "./output";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "./selection";

/** Explicit false wins even inside a PTY; a data-owned stdin never becomes a prompt channel. */
export function canPrompt(options: { interactive?: boolean; stdinOwned?: boolean } = {}): boolean {
  return options.interactive !== false && !options.stdinOwned
    && !!process.stdin.isTTY && !!terminalOutputStream().isTTY;
}

export async function chooseParameter(
  name: string, choices: readonly string[], interactive: boolean,
): Promise<string> {
  if (!choices.length) throw new CommandInputError(`${name} 没有可用候选`);
  if (choices.length === 1) return choices[0]!;
  if (!interactive) throw new CommandInputError(`请指定 ${name}；候选：${choices.join(", ")}`);
  printNumberedChoices(choices, name, choice => choice);
  const selected = await promptListedChoice({
    question: "请输入序号或名称（q 取消）：",
    match: answer => matchListedChoice(choices, answer, choice => choice, choice => choice),
    invalidMessage: "请选择列出的候选。",
  });
  if (selected === undefined) throw new ParameterCancelled();
  return selected;
}

export class ParameterCancelled extends Error {}

export async function inputParameter(name: string, interactive: boolean): Promise<string> {
  if (!interactive) throw new CommandInputError(`请指定 ${name}`);
  return withTerminalInput(async () => {
    const terminal = createInterface({ input: process.stdin, output: terminalOutputStream() });
    try {
      const value = await terminal.question(`${name}：`, { signal: currentCommandSignal() });
      if (!value.trim()) throw new CommandInputError(`${name} 不能为空`);
      return value;
    } finally { terminal.close(); }
  });
}
