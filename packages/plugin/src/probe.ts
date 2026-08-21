import type { PluginContext } from "./context";
import type { CapabilityWithAccess } from "./kubernetes";

/** Lifecycle context owned by the Command or Harness that schedules a Probe. */
export interface ProbeRunContext {
  runId: string;
  signal: AbortSignal;
}

/** One explicitly scheduled Probe invocation. */
export interface ProbeInvocation<Input> extends ProbeRunContext {
  input: Input;
}

/**
 * Executes one business or protocol action at each caller-owned dispatch point.
 * It must not create an independent scheduling loop.
 */
export interface ProbeRunner<Input, Observation> {
  setup?(context: ProbeRunContext): Promise<void>;
  run(input: ProbeInvocation<Input>): Promise<Observation>;
  /** Stop accepting new work after the caller has stopped dispatching this run. */
  deactivate?(context: ProbeRunContext): Promise<void>;
  /** Release run-scoped resources; callers attempt this even when setup/run fails. */
  cleanup?(context: ProbeRunContext): Promise<void>;
}

/**
 * A reusable active capability that maps caller-owned Input to an Observation.
 * Commands still own scheduling, authorization, Evidence composition and diagnosis.
 */
export interface ProbeCapability<Input, Observation, Options> extends CapabilityWithAccess {
  createRunner(
    context: PluginContext,
    options: Options,
  ): Promise<ProbeRunner<Input, Observation>>;
}
