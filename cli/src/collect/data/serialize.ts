import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandResult } from "../../command/result";
import type { SerializeContext } from "../../command/serialization/context";
import type { SerializedOutput } from "../../command/serialization/model";
import { readFacts } from "../evidence-reader";
import type { DataFacts, DataOutput } from "./model";
import { buildDataEvidenceSummary } from "./summary";

/** One invocation snapshot; per-input findings keep their own selection and coverage. */
export async function serializeData(context: SerializeContext, result: CommandResult<DataOutput>): Promise<SerializedOutput> {
  const source = result.artifacts[0];
  if (!source) return { files: {} };
  const { files: _files, ...metadata } = JSON.parse(readFileSync(join(source.path, "collection.json"), "utf8"));
  const facts = readFacts<DataFacts>(source.path, { files: _files });
  const factsFile = context.writeJson("raw/facts.json", facts);
  const positions = new Map(facts.capabilityResults.map((query, index) => [query.id, index]));
  const items = result.output?.items.map(item => {
    const selected = item.diagnosis?.evidence.facts.capabilityResults ?? [];
    const indices = selected.map(query => positions.get(query.id)!);
    return { bizId: item.bizId, status: item.status, reason: item.reason,
      selection: { file: "facts", queryIds: selected.map(query => query.id) },
      findings: item.diagnosis?.findings.map(finding => ({ ...finding, evidence: finding.evidence.map(ref =>
        "factPath" in ref ? { ...ref, factPath: ref.factPath.replace(/^capabilityResults\.(\d+)/,
          (_match, index) => `capabilityResults.${indices[Number(index)]}`) } : ref) })),
      coverage: item.diagnosis?.coverage };
  }) ?? [];
  for (const artifact of result.artifacts) context.bind(artifact, ".");
  // Query response bodies are represented by the authoritative Facts snapshot, not copied per step.
  const steps = (metadata.steps ?? []).map((step: Record<string, unknown>) => {
    const { raw_file, ...rest } = step;
    return { ...rest, ...(raw_file ? { raw_file: factsFile.path } : {}) };
  });
  return { files: {
    collection: context.writeJson("collection.json", { ...metadata, files: { facts: factsFile.path }, steps }),
    facts: factsFile,
    diagnosis: context.writeJson("diagnosis.json", { items }),
    summary: context.writeText("summary.md", buildDataEvidenceSummary(result.output?.items ?? [], facts)),
  } };
}
