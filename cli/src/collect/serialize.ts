import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, posix } from "node:path";
import type { CommandArtifact } from "../command/artifacts";
import type { CommandResult } from "../command/result";
import type { SerializeContext } from "../command/serialization/context";
import type { SerializedOutput, StoredFile } from "../command/serialization/model";

/** The Evidence schema owns this projection; the generic writer never guesses domain fields. */
export function serializeDiagnosis(context: SerializeContext, diagnosis: {
  evidence: { facts: unknown; observations: readonly unknown[]; [key: string]: unknown };
  [key: string]: unknown;
}, prefix = ""): { diagnosis: StoredFile; facts: StoredFile; observations: StoredFile } {
  const { evidence, ...conclusion } = diagnosis;
  const { facts, observations, ...derived } = evidence;
  const factsFile = context.writeJson(posix.join(prefix, "raw/facts.json"), facts);
  // A JSON document preserves the existing observation IDs without introducing another record identity.
  const observationsFile = context.writeJson(posix.join(prefix, "raw/observations.json"), observations);
  const derivedFile = Object.keys(derived).length
    ? context.writeJson(posix.join(prefix, "analysis/evidence.json"), derived) : undefined;
  const file = context.writeJson(posix.join(prefix, "diagnosis.json"), { ...conclusion,
    evidence: { facts: { file: "raw/facts.json" }, observations: { file: "raw/observations.json" },
      ...(derivedFile ? { derived: { file: "analysis/evidence.json" } } : {}) } });
  return { diagnosis: file, facts: factsFile, observations: observationsFile };
}

/** Import the files explicitly owned by an execution, preserving binary/streamed evidence. */
export function serializeEvidence(context: SerializeContext, artifacts: readonly CommandArtifact[]): SerializedOutput {
  const files: Record<string, StoredFile> = {};
  let metadata: Record<string, unknown> | undefined;
  for (const artifact of artifacts) {
    try {
      const prefix = artifacts.length === 1 ? "" : `items/${encodeURIComponent(artifact.id)}`;
      const stat = lstatSync(artifact.path);
      if (stat.isSymbolicLink()) throw new Error("Evidence contains a symbolic link");
      if (stat.isFile()) {
        files[artifact.id] = context.includeFile(posix.join(prefix, basename(artifact.path) === "manifest.json" ? "collection.json" : basename(artifact.path)), artifact.path);
        continue;
      }
      context.bind(artifact, prefix || ".");
      const manifestPath = join(artifact.path, "manifest.json");
      const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown> : {};
      const diagnosisPath = join(artifact.path, "diagnosis.json");
      const diagnosis = existsSync(diagnosisPath) ? JSON.parse(readFileSync(diagnosisPath, "utf8")) : undefined;
      const hasEvidence = diagnosis?.evidence?.facts !== undefined && Array.isArray(diagnosis.evidence.observations);
      const localFiles: Record<string, StoredFile> = {};
      const copy = (directory: string, relative = "") => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const file = posix.join(relative, entry.name);
          if (entry.isSymbolicLink()) throw new Error("Evidence contains a symbolic link");
          if (entry.isDirectory()) { copy(join(directory, entry.name), file); continue; }
          if (file === "manifest.json") continue;
          if (hasEvidence && ["diagnosis.json", "raw/facts.json"].includes(file)) continue;
          localFiles[file] = context.includeFile(posix.join(prefix, file), join(directory, entry.name));
        }
      };
      copy(artifact.path);
      if (hasEvidence) Object.assign(localFiles, serializeDiagnosis(context, diagnosis, prefix));
      const { files: sourceFiles, ...meta } = manifest;
      const aliases = sourceFiles as Record<string, string | StoredFile> | undefined;
      for (const [key, reference] of Object.entries(aliases ?? {})) {
        const path = typeof reference === "string" ? reference : reference.path;
        const file = Object.values(localFiles).find(file => file.path === posix.join(prefix, path));
        if (file) localFiles[key] = file;
      }
      if (prefix) {
        const relativeFiles = Object.fromEntries(Object.entries(localFiles).map(([key, file]) =>
          [key, { ...file, path: posix.relative(prefix, file.path) }]));
        files[artifact.id] = context.writeJson(`${prefix}/manifest.json`, { ...meta, files: relativeFiles });
      } else { Object.assign(files, localFiles); metadata = meta; }
    } catch (error) { context.failure(error); }
  }
  return { files, metadata };
}

export function serializeEvidenceResult(context: SerializeContext, result: CommandResult<unknown>): Promise<SerializedOutput> {
  return Promise.resolve(serializeEvidence(context, result.artifacts));
}
