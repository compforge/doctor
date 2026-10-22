import type { Case } from "@compforge/spec-case/model";
import { caseProducer, validateCaseProduceResult, validateHealthCaseBindingsResult,
  requireHealthCaseBindingsExtension, type CaseProduceResult,
  type HealthCaseBindingsExtension, type HealthCaseBindingsResult, type PluginDefinition,
  type ServiceCaseSource, type ServiceDefinition } from "@compforge/doctor-plugin";
import type { DoctorCaseSet } from "./catalog";
import { caseError } from "./http-check";

export interface CaseListOptions { services?: readonly string[]; caseset?: string; cases?: string; baseUrl?: string }
export interface CaseConsumer {
  service: string;
  workload: string;
  via: readonly string[];
}
export interface CaseListEntry {
  caseset: string;
  caseId: string;
  description?: string;
  provider: string;
  source?: string;
  consumers: CaseConsumer[];
  subject?: { id: string; label?: string };
  targets: { id: string; url: string }[];
  reason?: string;
}
export interface CaseListResult { entries: CaseListEntry[]; gaps: string[] }
export interface CaseListActions {
  signal: AbortSignal;
  consume(service: ServiceDefinition, extension: HealthCaseBindingsExtension): Promise<HealthCaseBindingsResult>;
  produce(service: ServiceDefinition, source: ServiceCaseSource): Promise<CaseProduceResult>;
}

function sourceKey(service: string, source: string): string { return JSON.stringify([service, source]); }

/** @spec Listing resolves fresh producer targets once per source, never creates a runner or sends a Case. */
export async function listDoctorCases(catalog: readonly DoctorCaseSet[], plugin: PluginDefinition | undefined,
  options: CaseListOptions, actions: CaseListActions): Promise<CaseListResult> {
  const result: CaseListResult = { entries: [], gaps: [] };
  const selected = options.services?.map(name => {
    const service = plugin?.services.find(name);
    if (!service) throw new Error(`Unknown Service: ${name}`);
    return service.name;
  });
  const ids = options.cases?.split(",").map(id => id.trim()).filter(Boolean);
  if (options.cases !== undefined && !ids?.length) throw new Error("--cases 未解析出任何 Case ID");
  const consumers = new Map<string, CaseConsumer[]>();
  for (const service of plugin?.services.services ?? []) {
    for (const raw of service.extensions ?? []) {
      if (raw.kind !== "health.case.bindings") continue;
      actions.signal.throwIfAborted();
      try {
        const extension = requireHealthCaseBindingsExtension(raw);
        const data = await actions.consume(service, extension);
        validateHealthCaseBindingsResult(data);
        for (const binding of data.bindings) {
          const provider = plugin!.services.caseSource(binding.producer);
          if (!service.workloads.some(workload => workload.name === binding.workload)) throw new Error(`Unknown Workload: ${binding.workload}`);
          for (const via of binding.via ?? []) {
            if (!plugin!.services.find(via)) throw new Error(`Unknown forwarding Service: ${via}`);
          }
          const key = sourceKey(provider.service.name, provider.source.id);
          const values = consumers.get(key) ?? [];
          const entry = { service: service.name, workload: binding.workload, via: binding.via ?? [] };
          if (!values.some(value => JSON.stringify(value) === JSON.stringify(entry))) values.push(entry);
          consumers.set(key, values);
        }
      } catch (error) {
        result.gaps.push(`${service.name}/${raw.id}: ${caseError(error)}`);
      }
    }
  }
  const sources = plugin?.services.caseSources() ?? [];
  const sets = [...catalog];
  for (const { service, source } of sources) {
    if (!sets.some(set => set.service === service.name && set.sourceId === source.id)) {
      sets.push({ source: "plugin", service: service.name, sourceId: source.id,
        caseSet: { caseset: source.id, cases: [] } });
    }
  }
  const generated = new Map<string, Promise<CaseProduceResult>>();
  for (const set of sets) {
    if (options.caseset && set.caseSet.caseset !== options.caseset) continue;
    const key = sourceKey(set.service ?? set.source, set.sourceId ?? set.caseSet.caseset);
    const bound = consumers.get(key) ?? [];
    if (selected && !selected.includes(set.service ?? "")
      && !bound.some(value => selected.includes(value.service) || value.via.some(via => selected.includes(via)))) continue;
    const definitions = set.caseSet.cases.filter(item => !ids || ids.includes(item.id));
    if (ids && set.caseSet.cases.length && !definitions.length) continue;
    const source = sources.find(item => item.service.name === set.service && item.source.id === set.sourceId);
    const base = { caseset: set.caseSet.caseset, provider: set.service ?? set.source, source: set.sourceId, consumers: bound };
    let produced: CaseProduceResult | undefined;
    let reason: string | undefined;
    if (source?.source.produce) {
      actions.signal.throwIfAborted();
      try {
        caseProducer(source.source);
        let pending = generated.get(key);
        if (!pending) {
          pending = actions.produce(source.service, source.source).then(value => {
            validateCaseProduceResult(value, 10);
            return value;
          });
          generated.set(key, pending);
        }
        produced = await pending;
        reason = [produced.reason, produced.truncated?.reason].filter(Boolean).map(value => caseError(value)).join("; ") || undefined;
        if (reason) result.gaps.push(`${base.provider}/${base.source}: ${reason}`);
      } catch (error) {
        reason = caseError(error);
        result.gaps.push(`${base.provider}/${base.source}: ${reason}`);
      }
    }
    const emitted = new Set<string>();
    for (const item of produced?.cases ?? []) {
      if (ids && !ids.includes(item.case.id)) continue;
      if (set.caseSet.cases.length && !set.caseSet.cases.some(def => def.id === item.case.id)) continue;
      emitted.add(item.case.id);
      result.entries.push({ ...base, caseId: item.case.id, description: item.case.desc, subject: item.subject,
        targets: item.targets.map(target => ({ id: target.id,
          url: caseError(typeof item.case.input.path === "string" ? new URL(item.case.input.path, target.url).toString() : target.url) })), reason });
    }
    for (const item of definitions) {
      if (emitted.has(item.id)) continue;
      const missing = reason ?? (source?.source.produce ? "本次 producer 未提供此 Case 的运行样本" : undefined);
      if (missing && !reason) result.gaps.push(`${base.provider}/${base.source}/${item.id}: ${missing}`);
      result.entries.push({ ...base, caseId: item.id, description: item.desc,
        targets: source?.source.produce ? [] : staticTargets(item, options.baseUrl),
        reason: missing });
    }
    if (!set.caseSet.cases.length && !emitted.size) {
      result.entries.push({ ...base, caseId: "(runtime)", targets: [], reason: reason ?? "未取得运行时 Case" });
    }
  }
  if ((options.caseset || ids) && !result.entries.length) throw new Error("没有匹配的 Case；请检查 --caseset / --cases / --service");
  return result;
}

function staticTargets(item: Case, baseUrl?: string): CaseListEntry["targets"] {
  if (!baseUrl || typeof item.input.path !== "string") return [];
  const url = new URL(item.input.path, baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Case URL 必须是无凭据的 HTTP(S) 地址");
  return [{ id: "base-url", url: caseError(url.toString()) }];
}

export function formatCaseList(result: CaseListResult): string {
  const cell = (value: string) => value.replace(/[\t\r\n\x1b]/g, " ");
  const rows = result.entries.flatMap(entry => {
    const consumers = entry.consumers.length ? entry.consumers : [undefined];
    const targets = entry.targets.length ? entry.targets : [undefined];
    return consumers.flatMap(consumer => targets.map(target => [
      `${entry.caseset}/${entry.caseId}`, entry.provider,
      consumer?.via.join(" → ") || "—",
      consumer ? `${consumer.service}/${consumer.workload}` : "未声明",
      target?.url ?? "未解析",
      entry.reason ?? (target ? "已解析，未执行" : "未提供 URL"),
    ].map(cell).join("\t")));
  });
  return [`Cases: ${result.entries.length}（仅列出；未执行 Case；URL 查询参数已脱敏）`,
    "CASE\tPROVIDER\tVIA\tCONSUMER/WORKLOAD\tURL\tSTATUS", ...rows,
    ...result.gaps.map(gap => `缺口: ${cell(gap)}`)].join("\n");
}
