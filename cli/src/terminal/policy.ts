import { AsyncLocalStorage } from "node:async_hooks";
import { CommandInputError } from "../command/result";

const invocation = new AsyncLocalStorage<{ yes: boolean }>();

/** @spec --yes suppresses all questions, not just approval prompts; child work inherits the invocation. */
export function withInteractionOptions<T>(options: { yes?: boolean }, work: () => T): T {
  return invocation.run({ yes: options.yes ?? invocation.getStore()?.yes ?? false }, work);
}

export function assumesYes(): boolean {
  return invocation.getStore()?.yes === true;
}

/** An injected terminal capability cannot override an explicit non-interactive invocation. */
export function isInteractive(terminal = !!(process.stdin.isTTY && process.stdout.isTTY)): boolean {
  return !assumesYes() && terminal;
}

export function requireInteractive(): void {
  if (assumesYes()) throw new CommandInputError("-y/--yes 禁止交互询问；请通过命令参数补齐必要信息");
}
