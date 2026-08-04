// 非 chat command 的统一终端输出边界：业务代码不要直接写 process.stdout/stderr。
// 子进程、协议 body 等原始数据用 write 原样透传；面向人的状态使用语义方法，确保
// 颜色策略、TTY/重定向判断与 NO_COLOR 支持始终只在这一层演进。
type TerminalTone = "info" | "success" | "warning" | "error" | "muted";

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

export function styleTerminalText(text: string, tone: TerminalTone, enabled = true): string {
  if (!enabled || text.length === 0) return text;
  const [open, close] = ANSI[tone];
  // 每行单独 reset，避免多行消息在异常中断时把后续 shell prompt 一并染色。
  return text.replace(/[^\n]+/g, (line) => `${open}${line}${close}`);
}

/**
 * 非 chat command 的统一终端出口。write 保留原始字节；语义方法仅在 TTY 中加色，
 * 因此子进程透传、重定向、Evidence 产物和脚本消费都不会混入 ANSI 控制符。
 */
export class TerminalOutput {
  constructor(
    private readonly stream: TerminalWritable,
    private readonly environment: () => TerminalEnvironment = () => process.env,
  ) {}

  write(chunk: string | Uint8Array): boolean {
    return this.stream.write(chunk);
  }

  info(text: string): boolean {
    return this.writeStyled(text, "info");
  }

  success(text: string): boolean {
    return this.writeStyled(text, "success");
  }

  warning(text: string): boolean {
    return this.writeStyled(text, "warning");
  }

  error(text: string): boolean {
    return this.writeStyled(text, "error");
  }

  result(ok: boolean, text: string): boolean {
    return ok ? this.success(text) : this.error(text);
  }

  muted(text: string): boolean {
    return this.writeStyled(text, "muted");
  }

  private writeStyled(text: string, tone: TerminalTone): boolean {
    return this.stream.write(styleTerminalText(
      text,
      tone,
      supportsTerminalColor(this.stream, this.environment()),
    ));
  }
}

export const terminalStdout = new TerminalOutput(process.stdout);
export const terminalStderr = new TerminalOutput(process.stderr);
