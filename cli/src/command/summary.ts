import { validateSummary, type Summary } from "@compforge/doctor-plugin";

/** One bounded projection for terminal, Markdown and HTML. Never walk arbitrary response bodies. */
export interface SummaryProjection {
  title: string;
  fields: { label: string; value: string }[];
  omitted: number;
}

export function summaryValue(value: unknown, depth = 0): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (depth >= 2) return `[${value.length} items]`;
    const values = value.slice(0, 8).map(item => summaryValue(item, depth + 1) ?? "—");
    return `[${values.join(", ")}${value.length > 8 ? `, … (${value.length} items)` : ""}]`.slice(0, 512);
  }
  if (typeof value === "object") return "[object; see raw evidence]";
  const text = String(value).replace(/[\r\n]+/g, " ");
  return text.length > 512 ? `${text.slice(0, 512)}…` : text;
}

export function projectSummary(summary: Summary, data: unknown): SummaryProjection {
  validateSummary(summary);
  const selected = summary.fields.slice(0, 12);
  const fields = selected.flatMap(field => {
    let value = data;
    for (const key of field.path) {
      // Accessors may execute plugin code or materialize resource bodies after disposal.
      value = value !== null && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
    }
    const text = summaryValue(value);
    return text === undefined ? [] : [{ label: summaryValue(field.label)!, value: text }];
  });
  return { title: summaryValue(summary.title)!, fields, omitted: Math.max(0, summary.fields.length - selected.length) };
}

export function summaryText(value: unknown, limit = 512): string {
  const text = String(value ?? "—").replace(/[\r\n]+/g, " ");
  return (text.length > limit ? `${text.slice(0, limit)}…` : text)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]#|])/g, "\\$1");
}

export function renderSummary(summary: Summary, data: unknown): string {
  const projection = projectSummary(summary, data);
  return [`# ${summaryText(projection.title)}`, "",
    ...projection.fields.map(field => `- ${summaryText(field.label)}：${summaryText(field.value)}`),
    ...(projection.omitted ? [`- 另有 ${projection.omitted} 个字段，见原始数据。`] : []), ""].join("\n");
}
