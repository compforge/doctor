import type { Client } from "./client";
import type { DataSource } from "./datasource";

/** Commands borrow clients; only the root owner receives the disposal capability. */
export interface ClientProvider {
  get<C extends Client>(source: DataSource<C>): Promise<C>;
}

/** @spec One command tree shares successful initialization per identity and closes clients at finalize. */
export class ClientManager implements ClientProvider {
  readonly #controller = new AbortController();
  readonly signal: AbortSignal;
  readonly #clients = new Map<string, Promise<Client>>();
  readonly #ready: Client[] = [];
  #disposal?: Promise<void>;

  constructor(signal?: AbortSignal) {
    this.signal = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
  }

  get<C extends Client>(source: DataSource<C>): Promise<C> {
    this.signal.throwIfAborted();
    const existing = this.#clients.get(source.key);
    if (existing) return existing as Promise<C>;
    // Publish before construction so concurrent callers never dispatch a second factory.
    const pending = Promise.resolve().then(async () => {
      this.signal.throwIfAborted();
      const client = source.createClient(this.signal);
      try {
        await client.initialize();
        this.signal.throwIfAborted();
        this.#ready.push(client);
        return client;
      } catch (error) {
        try { await client.dispose(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Client initialization and cleanup failed"); }
        throw error;
      }
    });
    this.#clients.set(source.key, pending);
    void pending.catch(() => { if (this.#clients.get(source.key) === pending) this.#clients.delete(source.key); });
    return pending;
  }

  dispose(): Promise<void> {
    return this.#disposal ??= (async () => {
      this.#controller.abort(new Error("Client manager disposed"));
      const settled = await Promise.allSettled(this.#clients.values());
      this.#clients.clear();
      // Dependencies must be acquired before their consumers initialize, so reverse readiness is safe.
      const errors: unknown[] = settled.flatMap(result => result.status === "rejected" && result.reason instanceof AggregateError
        ? [result.reason] : []);
      for (const client of this.#ready.splice(0).reverse()) {
        try { await client.dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Client cleanup failed");
    })();
  }
}
