import { join } from "node:path";
import { resolveArchivePath } from "../output/archive";

export type LogOutputFormat = "bundle" | "html";

export function parseLogOutputFormat(value: string | undefined): LogOutputFormat {
  const format = value?.trim() || "html";
  if (format !== "bundle" && format !== "html") {
    throw new Error(`--format 只支持 bundle 或 html: '${format}'`);
  }
  return format;
}

export function resolveLogOutputPath(
  output: string | undefined,
  bundleName: string,
  format: LogOutputFormat,
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
