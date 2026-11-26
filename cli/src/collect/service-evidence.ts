import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Manifest } from "../command/manifest";
import type { CollectKind } from "./composite";
import { dataTypeResult } from "./data/page";
import type { DataFacts } from "./data/model";
import type { InspectFacts, InspectObservation } from "./inspect/model";
import type { LogInspectionFacts, ServiceLogObservation } from "./log/model";
import type { CollectionRecord } from "./output/report/model";

export interface ServiceEvidence {
  service: string;
  kind: CollectKind;
  file: string;
  detail: string;
  scope?: string;
  gap?: boolean;
}

/** @spec Only explicit owners and participants link to an artifact. Command-wide gaps stay in the command summary.
 * @link cli/docs/commands/collect.md
 */
export function readServiceEvidence(directory: string, path: string, kind: CollectKind, inputId?: string): ServiceEvidence[] {
  const base = dirname(path);
  const manifest = JSON.parse(readFileSync(join(directory, path), "utf8")) as Manifest;
  if (manifest.children.length) return manifest.children.flatMap(child =>
    readServiceEvidence(directory, join(base, child.manifest), kind, inputId));

  const rows: ServiceEvidence[] = [];
  function read<T>(key: string): T | undefined {
    const file = manifest.files[key];
    if (file) return JSON.parse(readFileSync(join(directory, base, file.path), "utf8")) as T;
  }
  const collection = read<CollectionRecord>("collection");
  const target = collection?.target;
  const scope = [inputId ?? target?.biz_id ?? target?.input_id, target?.tenant_id,
    collection?.params?.since_time, collection?.params?.until_time].filter(Boolean).join(" · ");
  function add(service: string, key: string, detail: string, gap = false) {
    const file = manifest.files[key];
    if (file) rows.push({ service, kind, file: join(base, file.path), scope, detail, gap });
  }
  // raw_file is an artifact-relative path; the manifest may index it under a semantic key such as "facts".
  const keysByPath = new Map(Object.entries(manifest.files).map(([key, file]) => [file.path, key]));
  for (const step of collection?.steps ?? []) {
    if (!step.service) continue;
    const rawKey = step.raw_file ? keysByPath.get(step.raw_file) : undefined;
    add(step.service, rawKey ?? "collection",
      [step.title, step.status, step.reason, step.truncation?.reason].filter(Boolean).join(" · "),
      Boolean(step.truncation) || !["ok", "unnecessary"].includes(step.status));
  }

  if (kind === "data" || kind === "tenant") {
    const facts = read<DataFacts>("facts");
    for (const [service, available] of Object.entries(facts?.services ?? {})) {
      if (available.inspect.status !== "collected") add(service, "facts",
        `services[${JSON.stringify(service)}].inspect · ${available.inspect.reason}`, true);
    }
    const inputs = new Map<string, string[]>();
    const diagnosis = read<{ items?: { bizId: string; selection?: { queryIds: string[] } }[] }>("diagnosis");
    for (const item of diagnosis?.items ?? []) for (const id of item.selection?.queryIds ?? []) {
      const ids = inputs.get(id) ?? [];
      ids.push(item.bizId);
      inputs.set(id, ids);
    }
    for (const [i, query] of (facts?.capabilityResults ?? []).entries()) {
      const at = `capabilityResults.${i}`;
      const identity = [...(inputs.get(query.id) ?? []), `${query.identity.kind}=${query.identity.value}`].join(" · ");
      const sources = query.status === "collected" ? query.result.sources : query.sources;
      for (const [j, source] of (sources ?? []).entries()) {
        if (source.status === "collected") continue;
        const locator = `${at}.${query.status === "collected" ? "result." : ""}sources.${j}`;
        add(query.service, "facts", [locator, identity, source.source, source.status,
          "reason" in source && source.reason, source.observedAt].filter(Boolean).join(" · "), source.status !== "not_found");
      }
      if (query.status === "collected") {
        for (const reason of query.result.missingEvidence ?? []) add(query.service, "facts", `${at} · ${identity} · ${reason}`, true);
        if (query.result.truncated) add(query.service, "facts", `${at} · ${identity} · 已截断：${query.result.truncated.reason}`, true);
      }
      if (query.status !== "collected" || !query.result.facts.length) {
        add(query.service, "facts", `${at} · ${identity} · ${query.status === "collected" ? "返回 0 条记录" : query.reason}`, query.status !== "collected");
        continue;
      }
      query.result.facts.forEach((fact, j) => {
        const label = fact.factType === "record" ? fact.recordKey : fact.kind;
        add(query.service, "facts", [`${at}.result.facts.${j}`, identity, label,
          fact.factType !== "relation" && fact.summary?.text].filter(Boolean).join(" · "));
      });
    }
    facts?.typeResults?.forEach((query, i) => {
      const result = dataTypeResult(query);
      add(query.service, "facts", [`typeResults.${i}`, query.bizType, result.status,
        "reason" in result ? result.reason : result.data.truncated?.reason].filter(Boolean).join(" · "), result.status !== "ok");
    });
  }
  if (kind === "inspect") {
    const targets = read<InspectFacts>("facts")?.serviceTargets;
    if (targets?.status === "collected") for (const target of Object.values(targets.services)) {
      add(target.service, "facts", `serviceTargets.services[${JSON.stringify(target.service)}]`);
      for (const workload of Object.values(target.workloads)) {
        for (const unavailable of workload.unavailableDeployments ?? []) add(target.service, "facts",
          `${workload.name}/${unavailable.deployment} · ${unavailable.reason}`, true);
        if (workload.podRuntime.status !== "collected") add(target.service, "facts",
          `${workload.name} · ${workload.podRuntime.status} · ${workload.podRuntime.reason}`, true);
      }
    }
    for (const observation of read<InspectObservation[]>("observations") ?? []) {
      const services = "service" in observation ? [observation.service] : observation.services;
      for (const service of services) add(service, "observations",
        [observation.id, "workload" in observation && observation.workload, "pod" in observation && observation.pod,
          "status" in observation && observation.status, "reason" in observation && observation.reason].filter(Boolean).join(" · "),
        "status" in observation && ["failed", "partial", "unavailable"].includes(observation.status));
    }
  }
  if (kind === "log") {
    // Older captures have service-scoped observations but no explicit owner on each raw log step.
    if (!collection?.steps?.some(step => step.service)) {
      const observations = read<ServiceLogObservation[]>("observations");
      for (const [i, observation] of (observations ?? []).entries()) {
        for (const [j, pod] of observation.pods.entries()) add(observation.service, "observations",
          `[${i}].pods[${j}] · ${pod.pod} · ${pod.captureStatus}`, pod.captureStatus !== "complete");
      }
    }
    const pods = read<LogInspectionFacts>("facts")?.servicePods;
    if (pods?.status === "collected") for (const [service, missing] of Object.entries(pods.missing)) {
      for (const reason of missing) add(service, "facts", reason, true);
    }
  }
  if (kind === "trace") {
    // The compact trace tree shares span identities with the authoritative JSONL.
    const tree = read<{ trace_id: string; collection: { complete: boolean }; nodes: {
      service?: string; primary_span_id?: string;
    }[] }>("tree");
    if (!tree) return rows;
    const seen = new Set<string>();
    for (const node of tree.nodes) {
      if (!node.service || seen.has(node.service)) continue;
      seen.add(node.service);
      add(node.service, manifest.files.spans ? "spans" : "tree",
        [`Trace ${tree.trace_id}`, node.primary_span_id && `span ${node.primary_span_id}`,
          !tree.collection.complete && "Trace 覆盖不完整"].filter(Boolean).join(" · "), !tree.collection.complete);
    }
  }
  return rows;
}
