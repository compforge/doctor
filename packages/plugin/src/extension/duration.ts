import { validateExtension, type Extension, type ExtensionRegistration } from "./index";
import type { DurationSummaryQuery, DurationSummary } from "../duration";

export const DURATION_SUMMARIZE_KIND = "duration.summarize";

/** Independently executable duration statistics; does not participate in facet.sample. */
export interface DurationSummarizeExtension extends Extension<DurationSummaryQuery, DurationSummary> {
  readonly kind: typeof DURATION_SUMMARIZE_KIND;
}

export function requireDurationSummarizeExtension(extension: ExtensionRegistration): DurationSummarizeExtension {
  validateExtension(extension);
  if (extension.kind !== DURATION_SUMMARIZE_KIND) throw new Error(`Expected ${DURATION_SUMMARIZE_KIND}, got ${extension.kind}`);
  return extension as DurationSummarizeExtension;
}
