import { ToolboxError } from "@compforge/harness-toolbox/errors";

export const CLEANUP_TIMEOUT_MS = 5000;

/** @spec The execution budget signals the actual I/O owner; work must settle after cancellation. */
export async function withDeadline<T>(parent: AbortSignal, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ToolboxError(`Operation timed out after ${timeoutMs}ms`, { kind: "timeout" })), timeoutMs);
  const signal = AbortSignal.any([parent, controller.signal]);
  try {
    const result = await work(signal);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally { clearTimeout(timer); }
}

/** Cleanup cannot prevent delivery; a faulty disposer may outlive this wait, but is never retried. */
export async function disposeWithinBudget(dispose: () => void | Promise<void>, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(dispose), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ToolboxError("Resource cleanup timed out", { kind: "timeout" })), Math.max(0, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}
