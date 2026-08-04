export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 把结构化数据安全嵌入 application/json，避免内容提前闭合 script 标签。 */
export function serializeInlineJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function htmlHeading(level: 1 | 2 | 3, text: unknown): string {
  return `<h${level}>${escapeHtml(text)}</h${level}>`;
}

export function htmlParagraph(text: unknown): string {
  return `<p>${escapeHtml(text)}</p>`;
}

export function htmlList(items: readonly unknown[]): string {
  if (!items.length) return "";
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}
