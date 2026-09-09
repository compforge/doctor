import { createHash } from "node:crypto";
export type { Client } from "./client";
export { ClientManager, type ClientProvider } from "./client-manager";
import type { Client } from "./client";
import type { Transport } from "./transport";

/** Identity must include protocol, target, configuration and credentials; never an object address. */
export interface DataSource<C extends Client> {
  readonly key: string;
  /** Construct only; Client.initialize owns external work. */
  createClient(signal: AbortSignal): C;
}

/** Resolution owns configuration semantics; transports preserve the resolved target and identity. */
export interface ConnectionSource<Target> {
  resolve(): Promise<Target>;
  readonly transports: readonly Transport[];
}

export interface ClientLifecycle {
  signal?: AbortSignal;
  onDispose?: (dispose: () => Promise<void>) => void;
  /** Safe route facts only: no credentials, SQL or protocol payloads. */
  onRoute?: (route: { transport: string; reason?: string }) => void;
}

/** Stable in-memory identity; connection credentials must not appear in observable cache keys. */
export function dataSourceKey(protocol: string, configuration: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
    );
    return value;
  };
  return `${protocol}:${createHash("sha256").update(JSON.stringify(canonical(configuration))).digest("hex")}`;
}
