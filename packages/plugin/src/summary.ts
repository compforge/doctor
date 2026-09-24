/** Producer-owned reading hints. Paths are relative to the accompanying data, never a renderer. */
export interface Summary {
  readonly title: string;
  readonly fields: readonly { readonly label: string; readonly path: readonly string[] }[];
}

export function validateSummary(value: unknown): asserts value is Summary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Summary must be an object");
  const summary = value as Record<string, unknown>;
  if (typeof summary.title !== "string" || !summary.title.trim()) throw new Error("Summary.title must be a non-empty string");
  if (!Array.isArray(summary.fields)) throw new Error("Summary.fields must be an array");
  for (const field of summary.fields) {
    if (!field || typeof field !== "object" || typeof field.label !== "string" || !field.label.trim()
      || !Array.isArray(field.path) || !field.path.every((key: unknown) => typeof key === "string" && key.length > 0)) {
      throw new Error("Summary field requires a label and a string path");
    }
  }
}
