import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { CommandManifest, StoredFile, StoredResultRef } from "./model";

export function summaryText(value: unknown, limit = 512): string {
  const text = String(value ?? "—").replace(/[\r\n]+/g, " ");
  return (text.length > limit ? `${text.slice(0, limit)}…` : text)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]#|])/g, "\\$1");
}

/** Navigation reads only inventories already serialized by this invocation. */
export function summaryNavigation(directory: string, files: Readonly<Record<string, StoredFile>>,
  children: readonly StoredResultRef[]): string[] {
  const manifests = [...new Set([...children.map(child => child.manifest),
    ...Object.values(files).map(file => file.path).filter(path => path.endsWith("/manifest.json"))])];
  const lines: string[] = [];
  for (const path of manifests) {
    const manifest = JSON.parse(readFileSync(join(directory, path), "utf8")) as CommandManifest & { target?: unknown };
    const links = [["清单", path], ...["summary", "summary.md", "findings", "facts", "spans", "diagnosis"].flatMap(key => {
      const file = manifest.files?.[key];
      return file ? [[key, posix.join(posix.dirname(path), file.path)]] : [];
    })];
    const unique = [...new Map(links.map(([label, path]) => [path, [label, path]])).values()];
    const target = manifest.target ? ` · ${summaryText(JSON.stringify(manifest.target), 320)}` : "";
    lines.push(`- ${summaryText(manifest.command ?? "evidence")} · ${summaryText(manifest.status ?? "unknown")}${target}`,
      `  ${unique.map(([label, path]) => `[${label}](<${path}>)`).join(" · ")}`);
    if (manifest.reason) lines.push(`  原因：${summaryText(manifest.reason)}`);
    if (manifest.serialization?.status === "failed") lines.push("  序列化：failed");
  }
  if (!lines.length) {
    for (const key of ["diagnosis", "facts", "observations", "findings", "spans"]) {
      if (files[key]) lines.push(`- [${key}](<${files[key]!.path}>)`);
    }
  }
  return lines.length ? ["", "<!-- doctor:evidence-navigation -->", "## 证据导航", "", ...lines, ""] : [];
}
