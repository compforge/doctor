import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BundleManifest, HtmlReportOptions } from "./model";
import { buildHtmlReport } from "./shell";

/** 把 Evidence Bundle 渲染成可直接双击打开的单文件 HTML；不引用任何外部资源。 */
export function writeHtmlReport(bundleDir: string, outputPath: string, options: HtmlReportOptions): void {
  const manifestText = readFileSync(join(bundleDir, "manifest.json"), "utf-8");
  const manifest = JSON.parse(manifestText) as BundleManifest;
  writeFileSync(resolve(outputPath), buildHtmlReport(manifest, options), "utf-8");
}
