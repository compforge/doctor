import type { ManagedPluginContext } from "../plugin/context";
import { terminalStderr } from "../terminal/output";

/**
 * @spec Context lifetime ends with the body, not with response headers.
 * @why Explicit reader cancellation keeps abort independent of writable-side backpressure.
 */
export function scopedModelStream(body: ReadableStream<Uint8Array>, context: ManagedPluginContext,
  signal: AbortSignal, service: string): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let terminal = false;
  let disposed: Promise<void> | undefined;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const dispose = () => {
    signal.removeEventListener("abort", abort);
    return disposed ??= context.dispose().finally(() => reader.releaseLock());
  };
  const abort = () => {
    if (terminal) return;
    terminal = true;
    output.error(signal.reason);
    void reader.cancel(signal.reason).finally(dispose).catch(error =>
      terminalStderr.warning(`[model] ${service} stream cancellation cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`));
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (terminal) return;
        if (next.done) {
          terminal = true;
          try { await dispose(); controller.close(); }
          catch (error) { controller.error(error); }
        } else controller.enqueue(next.value);
      } catch (error) {
        if (terminal) return;
        terminal = true;
        try { await dispose(); } finally { controller.error(error); }
      }
    },
    async cancel(reason) {
      if (terminal) return disposed;
      terminal = true;
      try { await reader.cancel(reason); } finally { await dispose(); }
    },
  });
}
