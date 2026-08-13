import { discoverLocalContainerEngine } from "./container-engine";
import type { LocalContainerEngine } from "./container-engine";

export type ResolvedHostExecution<ContainerValue, ProcessValue> =
  | {
    readonly kind: "host-container";
    readonly engine: LocalContainerEngine;
    readonly value: ContainerValue;
  }
  | { readonly kind: "host-process"; readonly value: ProcessValue };

export interface ResolveHostExecutionOptions<ContainerValue, ProcessValue> {
  readonly container?: (
    engine: LocalContainerEngine,
  ) => Promise<ContainerValue | undefined>;
  readonly process: () => Promise<ProcessValue>;
  readonly discoverContainerEngine?: () => Promise<LocalContainerEngine | undefined>;
}

/** Prefer an already usable Host container; probing never prepares or loads an image. */
export async function resolveHostExecution<ContainerValue, ProcessValue>(
  options: ResolveHostExecutionOptions<ContainerValue, ProcessValue>,
): Promise<ResolvedHostExecution<ContainerValue, ProcessValue>> {
  const engine = await (
    options.discoverContainerEngine ?? discoverLocalContainerEngine
  )();
  if (engine && options.container) {
    const value = await options.container(engine);
    if (value !== undefined) return { kind: "host-container", engine, value };
  }
  return { kind: "host-process", value: await options.process() };
}
