import { CLEANUP_TIMEOUT_MS, disposeWithinBudget } from "./deadline";
import { executionDiagnostic, type ExecutionDiagnostic } from "./diagnostic";
import type { ClientManager } from "@compforge/harness-common";
import { AsyncLocalStorage } from "node:async_hooks";

interface ExecutionScope {
  signal: AbortSignal;
  diagnostics: ExecutionDiagnostic[];
  clients?: Pick<ClientManager, "get">;
  disposers: Set<() => void | Promise<void>>;
}

const execution = new AsyncLocalStorage<ExecutionScope>();

/** Host adapters inherit cancellation without exposing the Core context to Plugin code. */
export function currentCommandSignal(): AbortSignal | undefined {
  return execution.getStore()?.signal;
}

export function currentCommandClients(): Pick<ClientManager, "get"> | undefined {
  return execution.getStore()?.clients;
}

export function onCommandDispose(dispose: () => void | Promise<void>): () => void {
  const scope = execution.getStore();
  scope?.disposers.add(dispose);
  return () => { scope?.disposers.delete(dispose); };
}

/** Record caught failures in the current invocation, including failures that degrade coverage. */
export function recordExecutionFailure(error: unknown, context: Parameters<typeof executionDiagnostic>[1]): void {
  execution.getStore()?.diagnostics.push(executionDiagnostic(error, context));
}

export async function inCommandScope<T>(signal: AbortSignal, work: () => Promise<T>, clients?: Pick<ClientManager, "get">,
  options: { diagnostics?: ExecutionDiagnostic[]; cleanupTimeoutMs?: number } = {}): Promise<T> {
  const scope: ExecutionScope = { signal, clients, diagnostics: options.diagnostics ?? [], disposers: new Set() };
  return execution.run(scope, async () => {
    let failed = false;
    let failure: unknown;
    try { return await work(); }
    catch (error) { failed = true; failure = error; throw error; }
    finally {
      const errors: unknown[] = [];
      const deadline = Date.now() + (options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS);
      // Invocation-owned temporary resources are released in reverse acquisition order.
      for (const dispose of [...scope.disposers].reverse()) {
        const startedAt = Date.now();
        try { await disposeWithinBudget(dispose, deadline - Date.now()); }
        catch (error) {
          recordExecutionFailure(error, { phase: "cleanup", target: "invocation resources", startedAt });
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(failed ? [failure, ...errors] : errors, "Command resource cleanup failed");
    }
  });
}
