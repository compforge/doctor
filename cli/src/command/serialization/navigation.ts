import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Manifest, StoredFile, ResultRef } from "../manifest";
import { summaryText, type SummaryProjection } from "../summary";

export function summaryNavigation(directory: string, files: Readonly<Record<string, StoredFile>>,
  children: readonly ResultRef[]): string[] {
  const lines: string[] = [];
  for (const child of children.slice(0, 24)) {
    const path = child.manifest;
    const manifest = JSON.parse(readFileSync(join(directory, path), "utf8")) as Manifest;
    const links = [["清单", path], ...["summary", "findings", "facts", "spans", "diagnosis"].flatMap(key => {
      const file = manifest.files[key];
      return file ? [[key, posix.join(posix.dirname(path), file.path)]] : [];
    })];
    lines.push(`- ${summaryText(manifest.title)} · ${manifest.execution.status}`);
    if (manifest.files.summaryProjection) {
      const projection = JSON.parse(readFileSync(join(directory, posix.dirname(path), manifest.files.summaryProjection.path), "utf8")) as SummaryProjection;
      lines.push(...projection.fields.slice(0, 6).map(field => `  - ${summaryText(field.label)}：${summaryText(field.value)}`));
    }
    lines.push(`  ${links.map(([label, path]) => `[${label}](<${path}>)`).join(" · ")}`);
    if (manifest.execution.reason) lines.push(`  原因：${summaryText(manifest.execution.reason)}`);
    if (manifest.serialization.status === "failed") lines.push("  序列化：failed");
  }
  if (children.length > 24) lines.push(`- 另有 ${children.length - 24} 个结果，见 manifest.json。`);
  if (!children.length) {
    for (const key of ["diagnosis", "facts", "observations", "findings", "spans", "collection", "output"]) {
      if (files[key]) lines.push(`- [${key}](<${files[key]!.path}>)`);
    }
  }
  return lines.length ? ["", "## 证据导航", "", ...lines, ""] : [];
}
