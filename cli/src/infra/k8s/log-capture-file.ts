import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { setImmediate } from "node:timers/promises";

const BLOCK_BYTES = 64 * 1024;

/** Append-only raw evidence: readers have independent cursors, memory holds at most one pending block. */
export class LogCaptureFile {
  #fd: number | undefined;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #flushed = 0;
  #finished = false;
  readonly #waiters = new Set<() => void>();

  constructor(readonly path: string) {}

  get size(): number { return this.#flushed + this.#pendingBytes; }

  append(line: string): void {
    const chunk = Buffer.from(`${line}\n`);
    this.#pending.push(chunk);
    this.#pendingBytes += chunk.length;
    if (this.#pendingBytes >= BLOCK_BYTES) this.#flush();
    this.#wake();
  }

  #flush(): void {
    if (!this.#pendingBytes) return;
    this.#fd ??= openSync(this.path, "w+", 0o600);
    const bytes = Buffer.concat(this.#pending, this.#pendingBytes);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.#fd!, bytes, offset, bytes.length - offset);
    this.#flushed += bytes.length;
    this.#pending = [];
    this.#pendingBytes = 0;
  }

  #wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }

  finish(): void {
    try {
      this.#flush();
      if (this.#flushed === 0) this.#fd ??= openSync(this.path, "w+", 0o600);
    }
    finally { this.close(); this.#finished = true; this.#wake(); }
  }

  /** Replay existing bytes and follow new bytes in order, including lines not yet flushed to disk. */
  async follow(onLine: (line: string) => void): Promise<void> {
    let cursor = 0;
    let pending = "";
    const decoder = new TextDecoder();
    const consume = (text: string) => {
      const lines = (pending + text).split("\n");
      pending = lines.pop()!;
      for (const line of lines) onLine(line);
    };
    while (true) {
      // Snapshot synchronously: a flush cannot move the pending block between the two branches.
      if (cursor < this.#flushed) {
        const buffer = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, this.#flushed - cursor));
        // Completed sources keep files, not open descriptors, for the rest of the root execution.
        const fd = this.#fd ?? openSync(this.path, "r");
        let count: number;
        try { count = readSync(fd, buffer, 0, buffer.length, cursor); }
        finally { if (this.#fd === undefined) closeSync(fd); }
        cursor += count;
        consume(decoder.decode(buffer.subarray(0, count), { stream: true }));
        // Large replays must not starve active network streams or other consumers.
        await setImmediate();
      } else if (cursor < this.size) {
        const buffer = Buffer.concat(this.#pending, this.#pendingBytes).subarray(cursor - this.#flushed);
        cursor += buffer.length;
        consume(decoder.decode(buffer, { stream: true }));
      } else if (this.#finished) {
        consume(decoder.decode());
        if (pending) onLine(pending);
        return;
      } else {
        await new Promise<void>(resolve => this.#waiters.add(resolve));
      }
    }
  }

  close(): void {
    if (this.#fd !== undefined) { closeSync(this.#fd); this.#fd = undefined; }
  }
}
