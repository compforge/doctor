import { basename, dirname, join, resolve } from "node:path";
import { runArgv, type ExecResult } from "../../infra/k8s/executor";

/** -o 给了就用（无 .tar.gz/.tgz 后缀时补 .tar.gz）；缺省 ./<bundleName>.tar.gz */
export function resolveArchivePath(output: string | undefined, bundleName: string): string {
  if (!output) return join(".", `${bundleName}.tar.gz`);
  if (output.endsWith(".tar.gz") || output.endsWith(".tgz")) return output;
  return `${output}.tar.gz`;
}

/**
 * 把证据目录打成 tar.gz（归档内保留 bundle 目录名作顶层，解开即还原目录形态）。
 * 用系统 tar：macOS / Linux 运维机都自带，免引第三方依赖进单二进制。
 */
export async function packBundle(bundleDir: string, archivePath: string): Promise<ExecResult> {
  return runArgv(
    ["tar", "-czf", resolve(archivePath), "-C", dirname(resolve(bundleDir)), basename(bundleDir)],
    { timeoutMs: 60_000 },
  );
}
