import type { PluginContext } from "./context";
import type { CapabilityWithAccess } from "./kubernetes";

/** A typed diagnostic lookup key. Its kind is domain-owned and independent of commands. */
export interface Identity {
  kind: string;
  value: string;
}

/**
 * A read intent passed from a Core command to a capability.
 *
 * @spec Query keeps one typed identity separate from capability-specific constraints; it does not carry command DTOs
 * @see {@link ../../../cli/docs/kernel.md}
 */
export interface Query<
  I extends Identity = Identity,
  Constraints = unknown,
> {
  identity: I;
  constraints?: Constraints;
}

/** Inspect output that remains reusable as stable context for the current diagnosis run. */
export interface FactBase {
  kind: string;
  /** Positive integer version of the Fact value schema. */
  schemaVersion: number;
}

/** One opaque domain value; a Query may return at most one ValueFact of each kind. */
export interface ValueFact<Value = unknown> extends FactBase {
  factType: "value";
  value: Value;
}

/** One repeatable opaque domain record, identified stably within its kind. */
export interface RecordFact<Value = unknown> extends FactBase {
  factType: "record";
  recordKey: string;
  record: Value;
}

/** A relationship proven between two diagnostic identities. */
export interface RelationFact<I extends Identity = Identity> extends FactBase {
  factType: "relation";
  from: I;
  to: I;
}

export type Fact = ValueFact | RecordFact | RelationFact;

export interface InspectQueryResult<F extends Fact = Fact> {
  facts: readonly F[];
}

/**
 * A reusable inspection capability. Facts are stable inputs for the current diagnosis run;
 * Commands own selection, traversal, Probe scheduling and Evidence composition.
 */
export interface InspectCapability<
  Q extends Query = Query,
  F extends Fact = Fact,
> extends CapabilityWithAccess {
  inspect(context: PluginContext, query: Q): Promise<InspectQueryResult<F>>;
}
