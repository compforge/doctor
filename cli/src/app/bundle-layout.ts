import { existsSync, statSync } from "node:fs";
import { basename, join, posix } from "node:path";
import type { CommandArtifact } from "../command/artifacts";

export interface BundleArtifact {
  readonly artifact: CommandArtifact;
  readonly path: string;
  readonly report?: string;
}

/** @rule Every artifact has an independent destination; all bundle references consume this one layout. */
export function planBundleArtifacts(artifacts: readonly CommandArtifact[]): readonly BundleArtifact[] {
  return artifacts.map(artifact => {
    const command = artifact.command.replace(/[^a-zA-Z0-9_-]+/g, "-") || "command";
    const directory = posix.join("artifacts", `${encodeURIComponent(artifact.id)}-${command}`);
    const isDirectory = statSync(artifact.path).isDirectory();
    return {
      artifact,
      path: isDirectory ? directory : posix.join(directory, basename(artifact.path)),
      report: isDirectory && existsSync(join(artifact.path, "report.html"))
        ? posix.join(directory, "report.html") : undefined,
    };
  });
}

export function createBundleManifest(command: string, commandCode: number, layout: readonly BundleArtifact[], report?: string) {
  return {
    schema_version: 1,
    kind: "doctor.bundle",
    command,
    exit_code: commandCode,
    report,
    artifacts: layout.map(({ artifact, path, report }) => ({ id: artifact.id, command: artifact.command, path, report })),
  };
}
