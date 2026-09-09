/** A protocol client owns its initialization and idempotent cleanup, including partial initialization. */
export interface Client {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
}
