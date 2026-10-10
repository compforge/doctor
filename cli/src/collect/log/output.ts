import { join } from "node:path";
import { resolveArchivePath } from "../output/archive";

export type LogOutputFormat = "default" | "bundle" | "html" | "summary";

export function parseLogOutputFormat(value: string | undefined): LogOutputFormat {
  const format = value?.trim() || "default";
  if (format !== "default" && format !== "bundle" && format !== "html" && format !== "summary") {
    throw new Error(`--format 只支持 bundle、html 或 summary: '${format}'`);
  }
  return format;
}

export function resolveLogOutputPath(
  output: string | undefined,
  bundleName: string,
  format: Exclude<LogOutputFormat, "summary">,
): string {
  if (format === "bundle") {
    if (/\.html$/i.test(output ?? "")) {
      throw new Error("--format bundle 的输出路径不能使用 .html 后缀");
    }
    return resolveArchivePath(output, bundleName);
  }
  if (!output) return join(".", `${bundleName}.html`);
  if (/\.(?:tar\.gz|tgz)$/i.test(output)) {
    throw new Error("--format html 的输出路径不能使用 .tar.gz/.tgz 后缀");
  }
  return output.toLowerCase().endsWith(".html") ? output : `${output}.html`;
}
