/**
 * Producer-owned reading hints for the accompanying evidence.
 *
 * @spec text explains what the evidence means and limits on judgment; fields expose supporting counts, objects, and evidence.
 * @spec The enclosing command or query result owns status: it describes execution completeness, not application health.
 * @rule For partial results, truncation, zero matches, or failed sources, explain what was obtained, what is missing, and which judgments remain unsupported.
 * @see {@link ../../../cli/docs/command-output.md#摘要与原始证据}
 */
export interface Summary {
  readonly title: string;
  /**
   * A few concise, producer-authored sentences interpreting the result and its limits.
   * Keep data details, record lists, and raw output in fields or linked evidence; text is not a detailed report.
   * Avoid repeating field values or inferring unsupported conclusions; bounded views may truncate long text.
   * Optional when the fields are self-explanatory; the accompanying data remains the machine contract.
   */
  readonly text?: string;
  /** Supporting evidence in reading order, with decisive facts before context for bounded views. Paths are relative to the accompanying data. */
  readonly fields: readonly { readonly label: string; readonly path: readonly string[] }[];
}

export function validateSummary(value: unknown): asserts value is Summary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Summary must be an object");
  const summary = value as Record<string, unknown>;
  if (typeof summary.title !== "string" || !summary.title.trim()) throw new Error("Summary.title must be a non-empty string");
  if (summary.text !== undefined && typeof summary.text !== "string") throw new Error("Summary.text must be a string");
  if (!Array.isArray(summary.fields)) throw new Error("Summary.fields must be an array");
  for (const field of summary.fields) {
    if (!field || typeof field !== "object" || typeof field.label !== "string" || !field.label.trim()
      || !Array.isArray(field.path) || !field.path.every((key: unknown) => typeof key === "string" && key.length > 0)) {
      throw new Error("Summary field requires a label and a string path");
    }
  }
}
