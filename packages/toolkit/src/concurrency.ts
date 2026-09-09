/** FIFO slots shared by callers; queued cancellation never starts external work. */
export class ConcurrencyPool {
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(readonly concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquire(signal);
    try {
      signal?.throwIfAborted();
      // Resume in the caller's async context, never execute work from another slot's release callback.
      return await work();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    }
  }

  #acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#active < this.concurrency) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = this.#waiting.indexOf(start);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(signal!.reason);
      };
      this.#waiting.push(start);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
