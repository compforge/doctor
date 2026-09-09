export interface ResourceLifetime {
  readonly signal: AbortSignal;
  onDispose(dispose: () => void | Promise<void>): void;
}

/**
 * @spec One execution tree owns shared resources, independent of individual callers.
 * Concurrent acquisition joins initialization; failure releases partial resources before retry.
 * Keys identify resources, never query results. Factories must use the supplied lifetime.
 */
export class ResourceScope implements ResourceLifetime {
  readonly #controller = new AbortController();
  readonly signal: AbortSignal;
  readonly #entries = new Map<string, Promise<unknown>>();
  readonly #disposers: Array<() => void | Promise<void>> = [];
  #disposal?: Promise<void>;

  constructor(signal?: AbortSignal) {
    this.signal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
  }

  onDispose(dispose: () => void | Promise<void>): void {
    this.#disposers.push(dispose);
  }

  acquire<T>(key: string, create: (lifetime: ResourceLifetime) => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    const existing = this.#entries.get(key);
    if (existing) return existing as Promise<T>;
    const lifetime = new ResourceScope(this.signal);
    const pending = Promise.resolve().then(async () => {
      try {
        this.signal.throwIfAborted();
        const value = await create(lifetime);
        this.signal.throwIfAborted();
        this.onDispose(() => lifetime.dispose());
        return value;
      } catch (error) {
        try { await lifetime.dispose(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Resource initialization and cleanup failed"); }
        throw error;
      }
    });
    this.#entries.set(key, pending);
    void pending.catch(() => {
      if (this.#entries.get(key) === pending) this.#entries.delete(key);
    });
    return pending;
  }

  dispose(): Promise<void> {
    return this.#disposal ??= (async () => {
      this.#controller.abort(new Error("Resource scope disposed"));
      // Initialization may still be registering partial resources. Drain it before cleanup.
      await Promise.allSettled(this.#entries.values());
      this.#entries.clear();
      const errors: unknown[] = [];
      for (const dispose of this.#disposers.splice(0).reverse()) {
        try { await dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Resource cleanup failed");
    })();
  }
}
