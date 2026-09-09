/**
 * Final execution outcome shared by leaf and composite commands.
 *
 * @spec Describes command completion, not the health of the diagnosed business.
 * Partial preserves useful results when some requested work failed; cancellation
 * stops further work even when earlier calls produced useful results.
 * Exit-code mapping belongs to the CLI boundary.
 */
export enum CommandStatus {
  /** Requested work completed, including an overview without optional collection. */
  Ok = "ok",
  /** Useful results are available, but some requested work did not complete. */
  Partial = "partial",
  /** The command could not fulfil its objective. */
  Failed = "failed",
  /** Execution was cancelled; already produced artifacts remain available. */
  Cancelled = "cancelled",
}
