import type { Command } from "commander";

function appendBizId(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function withBizIdInputs(command: Command, description: string): Command {
  return command
    .argument("[biz-ids...]", "业务 ID；等价于重复传入 --biz-id")
    .option("--biz-id <id>", description, appendBizId, []);
}

export function normalizeBizIds(positional: readonly string[], opts: Record<string, unknown>): string[] {
  const options = Array.isArray(opts.bizId) ? opts.bizId : opts.bizId ? [opts.bizId] : [];
  return [...new Set([...positional, ...options]
    .map((value) => String(value).trim())
    .filter(Boolean))];
}
