import { writeTerminalOutput } from "./interaction";

/** Results, prompts and raw bytes are never filtered by the execution logger. */
export function writeOutput(chunk: string | Uint8Array, stream: NodeJS.WriteStream = process.stdout): boolean {
  return writeTerminalOutput(stream, chunk);
}

export function terminalOutputStream(): NodeJS.WriteStream {
  return process.stdout;
}

export function writeMachineResult(value: unknown): void {
  writeOutput(`${JSON.stringify(value, null, 2)}\n`);
}

export type TerminalTone =
  | "info"
  | "success"
  | "warning"
  | "error"
  | "muted"
  | "blue"
  | "magenta";

interface TerminalWritable {
  isTTY?: boolean;
  write(chunk: string | Uint8Array): boolean;
}

type TerminalEnvironment = Readonly<Record<string, string | undefined>>;

const ANSI: Record<TerminalTone, readonly [open: string, close: string]> = {
  info: ["\u001B[36m", "\u001B[39m"],
  success: ["\u001B[1;32m", "\u001B[22;39m"],
  warning: ["\u001B[33m", "\u001B[39m"],
  error: ["\u001B[1;31m", "\u001B[22;39m"],
  muted: ["\u001B[2m", "\u001B[22m"],
  blue: ["\u001B[1;34m", "\u001B[22;39m"],
  magenta: ["\u001B[1;35m", "\u001B[22;39m"],
};

export function supportsTerminalColor(
  stream: Pick<TerminalWritable, "isTTY">,
  env: TerminalEnvironment = process.env,
): boolean {
  if (Object.hasOwn(env, "NO_COLOR")) return false;
  if (env.FORCE_COLOR === "0") return false;
  if (Object.hasOwn(env, "FORCE_COLOR")) return true;
  return stream.isTTY === true && env.TERM !== "dumb";
}

export function styleTerminalText(text: string, tone: TerminalTone, enabled = supportsTerminalColor(process.stdout)): string {
  if (!enabled || text.length === 0) return text;
  const [open, close] = ANSI[tone];
  // 每行单独 reset，避免多行消息在异常中断时把后续 shell prompt 一并染色。
  return text.replace(/[^\n]+/g, (line) => `${open}${line}${close}`);
}
