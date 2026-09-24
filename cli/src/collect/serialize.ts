import type { Summary } from "@compforge/doctor-plugin";
import { projectSummary, renderSummary } from "../command/summary";
import { CommandStatus } from "../command/status";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, posix } from "node:path";
import type { CommandArtifact } from "../command/artifacts";
import type { CommandResult } from "../command/result";
import type { SerializeContext } from "../command/serialization/context";
import type { Manifest, ExecutionStatus, StoredFile, ResultRef } from "../command/manifest";
import type { SerializedOutput } from "../command/serialization/model";

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

export interface ArtifactDescription {
  title: string;
  execution: ExecutionStatus;
  summary?: { summary: Summary; data: { file: string } };
}

/** Import owned collection files; this is the only artifact Manifest writer. */
export function serializeEvidence(context: SerializeContext, artifacts: readonly CommandArtifact[],
  descriptions: ReadonlyMap<string, ArtifactDescription> = new Map()): SerializedOutput {
  const files: Record<string, StoredFile> = {};
  const children: ResultRef[] = [];
  for (const artifact of artifacts) {
    try {
      const prefix = artifacts.length === 1 ? "" : `items/${encodeURIComponent(artifact.id)}`;
      const stat = lstatSync(artifact.path);
      if (stat.isSymbolicLink()) throw new Error("Evidence contains a symbolic link");
      if (stat.isFile()) {
        files[artifact.id] = context.includeFile(posix.join(prefix, basename(artifact.path)), artifact.path);
        continue;
      }
      context.bind(artifact, prefix || ".");
      const collectionPath = join(artifact.path, "collection.json");
      const collection = existsSync(collectionPath) ? JSON.parse(readFileSync(collectionPath, "utf8")) : {};
      const diagnosisPath = join(artifact.path, "diagnosis.json");
      const diagnosis = existsSync(diagnosisPath) ? JSON.parse(readFileSync(diagnosisPath, "utf8")) : undefined;
      const hasEvidence = diagnosis?.evidence?.facts !== undefined && Array.isArray(diagnosis.evidence.observations);
      const localFiles: Record<string, StoredFile> = {};
      const copy = (directory: string, relative = "") => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const file = posix.join(relative, entry.name);
          if (entry.isSymbolicLink()) throw new Error("Evidence contains a symbolic link");
          if (entry.isDirectory()) { copy(join(directory, entry.name), file); continue; }
          if (["manifest.json", "summary.json", "summary-projection.json"].includes(file)) continue;
          if (hasEvidence && ["diagnosis.json", "raw/facts.json", "raw/observations.json"].includes(file)) continue;
          localFiles[file] = context.includeFile(posix.join(prefix, file), join(directory, entry.name));
        }
      };
      copy(artifact.path);
      if (hasEvidence) Object.assign(localFiles, serializeDiagnosis(context, diagnosis, prefix));
      const aliases: Record<string, string> = { ...collection.files, collection: "collection.json", summary: "summary.md" };
      for (const [key, path] of Object.entries(aliases)) {
        const file = Object.values(localFiles).find(file => file.path === posix.join(prefix, path));
        if (file) localFiles[key] = file;
      }
      const description = descriptions.get(artifact.id) ?? { title: artifact.command,
        execution: { status: (collection.steps ?? []).some((step: { status: string }) => !["ok", "unnecessary"].includes(step.status))
          ? CommandStatus.Partial : CommandStatus.Ok } };
      if (description.summary) {
        const binding = description.summary;
        const data = JSON.parse(readFileSync(context.path(posix.join(prefix, binding.data.file)), "utf8"));
        localFiles.summarySpec = context.writeJson(posix.join(prefix, "summary.json"), binding);
        localFiles.summaryProjection = context.writeJson(posix.join(prefix, "summary-projection.json"), projectSummary(binding.summary, data));
        localFiles.summary = context.writeText(posix.join(prefix, "summary.md"),
          `${renderSummary(binding.summary, data)}\n采集状态：${description.execution.status}\n\n${localFiles.summary ? readFileSync(context.path(localFiles.summary.path), "utf8") : ""}\n[完整证据](manifest.json)\n`);
      }
      // Prefer semantic keys (facts, summary) over the copy pass's filename aliases.
      for (const [key, file] of Object.entries(localFiles)) {
        const filename = posix.relative(prefix || ".", file.path);
        if (key !== filename) delete localFiles[filename];
      }
      if (prefix) {
        if (!localFiles.summary) localFiles.summary = context.writeText(`${prefix}/summary.md`,
          `# ${description.title}\n\n采集状态：${description.execution.status}\n\n[完整证据](manifest.json)\n`);
        const relativeFiles = Object.fromEntries(Object.entries(localFiles).map(([key, file]) =>
          [key, { ...file, path: posix.relative(prefix, file.path) }]));
        const manifest: Manifest = { schemaVersion: 2, kind: "artifact", id: artifact.id,
          title: description.title, source: { command: artifact.command }, execution: description.execution,
          serialization: { status: "ok", errors: [] }, files: relativeFiles, children: [] };
        const path = `${prefix}/manifest.json`;
        files[artifact.id] = context.writeJson(path, manifest);
        children.push({ id: artifact.id, manifest: path });
      } else Object.assign(files, localFiles);
    } catch (error) { context.failure(error); }
  }
  return { files, children };
}

export function serializeEvidenceResult(context: SerializeContext, result: CommandResult<unknown>): Promise<SerializedOutput> {
  const descriptions = new Map(result.artifacts.map(artifact => [artifact.id, { title: artifact.command,
    execution: { status: result.status, reason: "reason" in result ? result.reason : undefined } }]));
  return Promise.resolve(serializeEvidence(context, result.artifacts, descriptions));
}
