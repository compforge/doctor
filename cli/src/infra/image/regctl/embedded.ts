import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

declare global {
  // Bun builds set this to a platform-specific $bunfs asset. Node SEA reads the same asset by key.
  var __DOCTOR_REGCTL_ASSET__: string | undefined;
}

let extractedCommand: string | undefined;
let extractedDirectory: string | undefined;

function readSeaAsset(): Uint8Array | undefined {
  if (process.versions.bun || !process.getBuiltinModule) return undefined;
  const sea = process.getBuiltinModule("node:sea") as typeof import("node:sea");
  return sea.isSea() ? new Uint8Array(sea.getRawAsset("doctor-regctl")) : undefined;
}

function readBunAsset(): Uint8Array | undefined {
  const path = globalThis.__DOCTOR_REGCTL_ASSET__;
  return path ? readFileSync(path) : undefined;
}

/** Materialize the embedded executable because operating systems cannot exec directly from Bun/SEA assets. */
export function resolveEmbeddedRegctlCommand(): string | undefined {
  if (extractedCommand) return extractedCommand;
  const bytes = readSeaAsset() ?? readBunAsset();
  if (!bytes) return undefined;

  const directory = mkdtempSync(join(tmpdir(), "doctor-regctl-"));
  const command = join(directory, "regctl");
  writeFileSync(command, bytes, { mode: 0o700 });
  extractedDirectory = directory;
  extractedCommand = command;
  return command;
}

process.once("exit", () => {
  if (extractedDirectory) rmSync(extractedDirectory, { recursive: true, force: true });
});
