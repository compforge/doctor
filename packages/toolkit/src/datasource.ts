import type { Transport } from "./transport";

/** Resolution owns configuration semantics; transports preserve the resolved target and identity. */
export interface DataSource<Target> {
  resolve(): Promise<Target>;
  readonly transports: readonly Transport[];
}

export interface ClientLifecycle {
  signal?: AbortSignal;
  onDispose?: (dispose: () => Promise<void>) => void;
  /** Safe route facts only: no credentials, SQL or protocol payloads. */
  onRoute?: (route: { transport: string; reason?: string }) => void;
}
