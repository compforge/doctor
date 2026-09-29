import { tmpdir } from "node:os";
import { constants, linkSync, mkdtempSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep, relative, isAbsolute } from "node:path";
import { packArchiveEntries } from "../collect/output/archive";
import { assertDeliveryPathsAvailable, type DeliveryPlan } from "./delivery-plan";
import type { Manifest } from "../command/manifest";

import { writeMachineResult, writeOutput } from "../terminal/output";
import { useLogger } from "../terminal/log";

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
export async function deliverSerialized(input: { directory: string; plan: DeliveryPlan;
  code: number }): Promise<boolean> {
  const { directory, plan: paths, code } = input;
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const { format } = paths;
  const errors: string[] = [];
  let root = directory;
  let metadata: Manifest = { ...manifest, delivery: { status: "ok", errors, exitCode: code,
    location: { directory, manifest: manifestPath } } };
  try {
    // Collection may take time: recheck every destination even when preflight passed.
    assertDeliveryPathsAvailable(paths);
    if (format === "manifest") {
      if (paths.directory) {
        root = paths.directory;
        mkdirSync(root, { mode: 0o700 });
        cpSync(directory, root, { recursive: true, errorOnExist: true, force: false });
      }
    } else {
      if (format === "summary") {
        const summaryPath = join(directory, manifest.files.summary!.path);
        writeOutput(readFileSync(summaryPath, "utf8"));
      }
      const files = paths.file ? [{ destination: paths.file.path,
        source: paths.file.format === "html" ? "report.html" : paths.file.format === "json"
          ? (manifest.files.diagnosis?.path ?? manifest.files.output?.path ?? "diagnosis.json") : manifest.files.summary!.path }] : [];
      const archive = paths.archive;
      for (const file of files) {
        try {
          await publishFile(file.destination, temporary => {
            if (format === "json") {
              const result = existsSync(join(directory, file.source)) ? JSON.parse(readFileSync(join(directory, file.source), "utf8")) : undefined;
              // The exported JSON lives outside the execution directory; make its relative evidence references resolvable.
              writeFileSync(temporary, `${JSON.stringify({ manifest: manifestPath, result }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
            } else if (format === "md") {
              const summary = existsSync(join(directory, file.source)) ? readFileSync(join(directory, file.source), "utf8") : `# ${manifest.title}\n\n${manifest.execution.status}\n`;
              writeFileSync(temporary, `${relocateSummaryLinks(summary, directory, dirname(file.destination))}\n[完整执行结果](${manifestPath})\n`, { mode: 0o600, flag: "wx" });
            } else {
              if (!existsSync(join(directory, file.source))) throw new Error(`Serialized result has no ${file.source}`);
              copyFileSync(join(directory, file.source), temporary, constants.COPYFILE_EXCL);
            }
          });
          writeOutput(`[delivery] ${file.source}: ${file.destination}\n`);
        } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      }
      if (archive) {
        metadata = { ...metadata, delivery: { status: errors.length ? "failed" : "ok", errors,
          exitCode: code === 130 ? 130 : errors.length ? 1 : code, location: { directory, manifest: manifestPath } } };
        writeFileSync(manifestPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
        await publishFile(archive, async temporary => {
          const packed = await packArchiveEntries(readdirSync(directory).map(name => ({ source: join(directory, name), path: name })), temporary);
          if (!packed.ok) throw new Error(packed.stderr);
        });
        writeOutput(`[delivery] Evidence Bundle: ${archive}\n`);
      }
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); root = directory; }
  const record: Manifest = { ...metadata, delivery: { status: errors.length ? "failed" : "ok", errors,
    exitCode: code === 130 ? 130 : errors.length ? 1 : code,
    location: { directory: root, manifest: join(root, "manifest.json") } } };
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  if (format === "manifest") writeMachineResult(record);
  for (const error of errors) useLogger("delivery").error(`${error}`);
  if (errors.length || !["manifest", "bundle", "default"].includes(format)) {
    writeOutput(`[delivery] Evidence: ${root}\n`, process.stderr);
    writeOutput(`[delivery] Manifest: ${join(root, "manifest.json")}\n`, process.stderr);
  }
  if (!errors.length && root !== directory) cleanupTemporaryArtifacts([directory]);
  return errors.length === 0;
}

/** Exported Markdown lives outside the evidence directory; keep its local links resolvable. */
function relocateSummaryLinks(markdown: string, source: string, destination: string): string {
  return markdown.replace(/\]\((<[^>]+>|[^)]+)\)/g, (match, target: string) => {
    const value = target.startsWith("<") ? target.slice(1, -1) : target;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("#") || isAbsolute(value)) return match;
    return `](<${relative(destination, resolve(source, value))}>)`;
  });
}

/** Fully prepare a file beside its destination, then publish without replacing another invocation's file. */
async function publishFile(destination: string, write: (temporary: string) => void | Promise<void>): Promise<void> {
  const staging = mkdtempSync(join(dirname(destination), ".doctor-publish-"));
  try {
    // Preserve the basename so tar's internal root matches the published archive.
    const temporary = join(staging, basename(destination));
    await write(temporary);
    chmodSync(temporary, 0o600);
    linkSync(temporary, destination);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
