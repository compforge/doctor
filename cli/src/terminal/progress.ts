export interface TerminalProgressUpdate {
  label: string;
  current: number;
  total: number;
  detail?: string;
  complete?: boolean;
}

export interface TerminalProgressLineOptions {
  isTTY: boolean;
  write(text: string): void;
  onRender?(line: string): void;
  width?: number;
}

export function formatProgressBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function formatTerminalProgress(
  update: TerminalProgressUpdate,
  width = 20,
): string {
  const ratio = update.total > 0 ? Math.min(1, update.current / update.total) : 1;
  const filled = Math.round(ratio * width);
  const bar = `${"=".repeat(filled)}${"-".repeat(width - filled)}`;
  return `${update.label} [${bar}] ${Math.round(ratio * 100)}%`
    + `（${formatProgressBytes(update.current)} / ${formatProgressBytes(update.total)}`
    + `${update.detail ? `，${update.detail}` : ""}）`;
}

/**
 * TTY 中复用一行刷新；重定向输出只保留约 10% 粒度的稳定日志。
 * 领域层提供 label/detail，组件不依赖文件传输或任何 collect 类型。
 */
export class TerminalProgressLine {
  private active = false;
  private lastNonTtyPercent = -10;
  private readonly width: number;

  constructor(private readonly options: TerminalProgressLineOptions) {
    this.width = options.width ?? 20;
  }

  update(update: TerminalProgressUpdate): void {
    const percent = update.total > 0
      ? Math.floor(Math.min(1, update.current / update.total) * 100)
      : 100;
    if (
      !this.options.isTTY
      && !update.complete
      && percent < this.lastNonTtyPercent + 10
    ) {
      return;
    }
    this.lastNonTtyPercent = Math.floor(percent / 10) * 10;
    const line = formatTerminalProgress(update, this.width);
    this.options.onRender?.(line);
    if (!this.options.isTTY) {
      this.options.write(`${line}\n`);
      if (update.complete) this.lastNonTtyPercent = -10;
      return;
    }
    this.options.write(`\r\x1b[2K${line}`);
    this.active = !update.complete;
    if (update.complete) {
      this.options.write("\n");
      this.lastNonTtyPercent = -10;
    }
  }

  interrupt(): void {
    if (!this.active) return;
    this.options.write("\n");
    this.active = false;
  }
}
