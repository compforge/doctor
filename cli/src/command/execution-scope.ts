import type { ClientProvider } from "@compforge/harness-toolbox/client-manager";
import { AsyncLocalStorage } from "node:async_hooks";

interface ExecutionScope {
  signal: AbortSignal;
  clients?: ClientProvider;
  disposers: Set<() => void | Promise<void>>;
}

const execution = new AsyncLocalStorage<ExecutionScope>();

/** Host adapters inherit cancellation without exposing the Core context to Plugin code. */
export function currentCommandSignal(): AbortSignal | undefined {
  return execution.getStore()?.signal;
}

export function currentCommandClients(): ClientProvider | undefined {
  return execution.getStore()?.clients;
}

export function onCommandDispose(dispose: () => void | Promise<void>): () => void {
  const scope = execution.getStore();
  scope?.disposers.add(dispose);
  return () => { scope?.disposers.delete(dispose); };
}

export async function inCommandScope<T>(signal: AbortSignal, work: () => Promise<T>, clients?: ClientProvider): Promise<T> {
  const scope: ExecutionScope = { signal, clients, disposers: new Set() };
  return execution.run(scope, async () => {
    let failed = false;
    let failure: unknown;
    try { return await work(); }
    catch (error) { failed = true; failure = error; throw error; }
    finally {
      const errors: unknown[] = [];
      // Invocation-owned temporary resources are released in reverse acquisition order.
      for (const dispose of [...scope.disposers].reverse()) {
        try { await dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(failed ? [failure, ...errors] : errors, "Command resource cleanup failed");
    }
  });
}
