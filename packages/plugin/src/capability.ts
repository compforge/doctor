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

/**
 * One independently consumable statement obtained from a diagnostic target.
 * `kind` identifies the schema family; one Query may return multiple records of the same kind.
 */
export interface Fact {
  kind: string;
}

/**
 * A Fact that proves a relationship between two diagnostic identities.
 * Core commands decide whether and how far a discovered identity is queried again.
 */
export interface Relation<I extends Identity = Identity> extends Fact {
  from: I;
  to: I;
}

/** A reusable inspection capability. Commands own selection, traversal and Evidence composition. */
export interface InspectCapability<
  Q extends Query = Query,
  F extends Fact = Fact,
> extends CapabilityWithAccess {
  query(context: PluginContext, query: Q): Promise<readonly F[]>;
}
