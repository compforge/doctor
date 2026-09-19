import { tmpdir } from "node:os";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { packArchiveEntries, resolveArchivePath, resolveDefaultReportPaths } from "../collect/output/archive";
import type { CommandManifest } from "../command/serialization/model";

import { terminalStderr, terminalStdout, writeMachineResult } from "../terminal/output";

export interface CommandDeliveryOptions { format?: string; output?: string }

export function cleanupTemporaryArtifacts(paths: readonly string[]): void {
  const temporaryRoot = `${resolve(tmpdir())}${sep}`;
  for (const path of paths) {
    const absolutePath = resolve(path);
    if (!absolutePath.startsWith(temporaryRoot)) continue;
    rmSync(absolutePath, { recursive: true, force: true });
    const parent = dirname(absolutePath);
    if (!parent.startsWith(temporaryRoot) || !basename(parent).startsWith("doctor-")) continue;
    try {
      rmdirSync(parent);
    } catch {
      // Other artifacts may still share the same command-owned temporary parent.
    }
  }
}

/** Delivery consumes an already serialized, portable directory. It never reconstructs domain results. */
export async function deliverSerialized(input: { directory: string; options: CommandDeliveryOptions;
  code: number; reportName: string }): Promise<boolean> {
  const { directory, options, code, reportName } = input;
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CommandManifest;
  let format = options.format?.trim() || "default";
  if (!["default", "html", "json", "md", "bundle", "manifest"].includes(format)) {
    terminalStderr.warning(`[delivery] 未识别 format '${format}'，按 default 交付 HTML + Bundle\n`);
    format = "default";
  }
  const errors: string[] = [];
  let root = directory;
  const publish = (path: string, action: () => void) => {
    if (existsSync(path)) throw new Error(`--output 已存在，为避免覆盖请换一个路径：${path}`);
    action();
  };
  const metadata = { ...manifest, status: code === 130 ? "cancelled" : code !== 0 ? "failed" : manifest.status, exit_code: code, execution: { status: manifest.status, reason: manifest.reason },
    delivery: { status: "ok", errors } };
  try {
    if (format === "manifest") {
      if (options.output) {
        root = resolve(options.output);
        publish(root, () => { mkdirSync(root, { mode: 0o700 }); cpSync(directory, root, { recursive: true }); });
      }
    } else {
      const paths = resolveDefaultReportPaths(options.output, reportName);
      const filePath = (extension: string) => {
        const path = options.output?.trim() || reportName;
        return resolve(path.endsWith(`.${extension}`) ? path : `${path}.${extension}`);
      };
      const files: { source: string; destination: string }[] = [];
      if (format === "default" || format === "html") files.push({ source: "report.html", destination: format === "default" ? paths.html : filePath("html") });
      if (format === "json" || format === "md") files.push({ source: format === "json" ? "diagnosis.json" : "summary.md", destination: filePath(format) });
      const archive = format === "default" ? paths.bundle : format === "bundle" ? resolveArchivePath(options.output, reportName) : undefined;
      // Validate every destination before publishing any output.
      for (const path of [...files.map(file => file.destination), ...(archive ? [archive] : [])]) {
        if (existsSync(path)) throw new Error(`--output 已存在，为避免覆盖请换一个路径：${path}`);
      }
      for (const file of files) {
        try {
          if (format === "json") {
            const result = existsSync(join(directory, file.source)) ? JSON.parse(readFileSync(join(directory, file.source), "utf8")) : undefined;
            // The exported JSON lives outside the execution directory; make its relative evidence references resolvable.
            writeFileSync(file.destination, `${JSON.stringify({ manifest: manifestPath, result }, null, 2)}\n`, { mode: 0o600 });
          } else if (format === "md") {
            const summary = existsSync(join(directory, file.source)) ? readFileSync(join(directory, file.source), "utf8") : `# ${manifest.command}\n\n${manifest.status}\n`;
            writeFileSync(file.destination, `${summary}\n[完整执行结果](${manifestPath})\n`, { mode: 0o600 });
          } else {
            if (!existsSync(join(directory, file.source))) throw new Error(`Serialized result has no ${file.source}`);
            copyFileSync(join(directory, file.source), file.destination);
            chmodSync(file.destination, 0o600);
          }
          terminalStdout.success(`[delivery] ${file.source}: ${file.destination}\n`);
        } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      }
      if (errors.length) {
        metadata.delivery.status = "failed";
        metadata.exit_code = code === 130 ? 130 : 1;
        metadata.status = code === 130 ? "cancelled" : "failed";
      }
      if (archive) {
        writeFileSync(manifestPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
        const packed = await packArchiveEntries(readdirSync(directory).map(name => ({ source: join(directory, name), path: name })), archive);
        if (!packed.ok) throw new Error(packed.stderr);
        chmodSync(archive, 0o600);
        terminalStdout.success(`[delivery] Evidence Bundle: ${archive}\n`);
      }
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); root = directory; }
  metadata.delivery.status = errors.length ? "failed" : "ok";
  metadata.exit_code = code === 130 ? 130 : errors.length ? 1 : code;
  if (errors.length && code !== 130) metadata.status = "failed";
  const record = { ...metadata, bundle_root: root, manifest: "manifest.json" };
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  if (format === "manifest") writeMachineResult(record);
  for (const error of errors) terminalStderr.error(`[delivery] ${error}\n`);
  if (errors.length || !["manifest", "bundle", "default"].includes(format)) terminalStderr.info(`[delivery] Evidence: ${root}\n`);
  if (!errors.length && root !== directory) cleanupTemporaryArtifacts([directory]);
  return errors.length === 0;
}
