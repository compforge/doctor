import { createInterface } from "node:readline/promises";
import {
  approveAll,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
} from "../command/approval";
import { prepareTerminalInput } from "./input";
import { terminalStderr, terminalStdout } from "./output";

export interface ApprovalCliOptions {
  yes?: boolean;
}

export function isApprovalAnswer(answer: string): boolean {
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

export async function promptForApproval(
  request: ApprovalRequest,
): Promise<ApprovalDecision> {
  terminalStdout.warning(`\n[operation] 操作确认：${request.title}\n`);
  if (request.purpose) {
    terminalStdout.write(`[operation] 用途：${request.purpose}\n`);
  }
  terminalStdout.write(`[operation] 目标：${request.target}\n`);
  for (const impact of request.impact) {
    terminalStdout.write(`[operation] - ${impact}\n`);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    terminalStderr.warning(
      "[operation] 当前为非交互终端，无法取得确认；"
      + "已取消该操作（可用 -y/--yes 预先批准）\n",
    );
    return { approved: false, source: "non-interactive" };
  }

  prepareTerminalInput();
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const approved = isApprovalAnswer(
      await readline.question("继续？[y/N] "),
    );
    return { approved, source: "prompt" };
  } catch {
    return { approved: false, source: "prompt" };
  } finally {
    readline.close();
  }
}

export function resolveApprovalGate(
  opts: ApprovalCliOptions,
): ApprovalGate {
  return opts.yes ? approveAll : promptForApproval;
}
