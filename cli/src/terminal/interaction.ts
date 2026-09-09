import { AsyncLocalStorage } from "node:async_hooks";
import { ConcurrencyPool } from "@compforge/doctor-toolkit/concurrency";
import { currentCommandSignal } from "../command/execution-scope";

const input = new ConcurrencyPool(1);
const owner = new AsyncLocalStorage<object>();
let active: object | undefined;
const pendingOutput: Array<() => void> = [];

/** One stdin owner; background command output waits until that interaction is complete. */
export function withTerminalInput<T>(work: () => Promise<T>): Promise<T> {
  return input.run(async () => {
    const token = {};
    active = token;
    try { return await owner.run(token, work); }
    finally {
      active = undefined;
      for (const write of pendingOutput.splice(0)) write();
    }
  }, currentCommandSignal());
}

export function writeTerminalOutput(
  stream: { write(chunk: string | Uint8Array): boolean }, chunk: string | Uint8Array,
): boolean {
  if (!active || owner.getStore() === active) return stream.write(chunk);
  pendingOutput.push(() => { stream.write(chunk); });
  return true;
}
