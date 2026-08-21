/** A typed diagnostic lookup key. Its kind is domain-owned and independent of commands. */
export interface Identity {
  kind: string;
  value: string;
}

/**
 * A read intent passed from a Core command to a capability.
 *
 * @spec Query keeps typed identities separate from capability-specific constraints; it does not carry command DTOs
 * @see {@link ../../../cli/docs/kernel.md}
 */
export interface Query<
  I extends Identity = Identity,
  Constraints = unknown,
> {
  identities: readonly I[];
  constraints?: Constraints;
}

/**
 * A proven relationship between two diagnostic identities.
 * Core commands decide whether and how far a discovered identity is queried again.
 */
export interface Relation<I extends Identity = Identity> {
  kind: string;
  from: I;
  to: I;
}
