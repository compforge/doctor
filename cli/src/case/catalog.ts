import type { Case, CaseSet } from "@compforge/spec-case/model";
import { loadCaseCatalog, MODEL_CASE_SET, type CaseSupport, type PluginDefinition } from "@compforge/doctor-plugin";
import { isInteractive } from "../terminal/policy";
import { promptMultiSelect } from "../terminal/multi-select";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "../terminal/selection";
import { httpCaseCatalog } from "./core-http";
import { localCaseCatalog } from "./local";

export type DoctorCaseCommand = "http" | "model" | "perf" | "eval";

export interface DoctorCaseSet {
  source: "builtin" | "plugin" | "local";
  service?: string;
  sourceId?: string;
  supports?: CaseSupport;
  file?: string;
  caseSet: CaseSet;
}

/** Offline assets have one owner; listing never prepares targets or creates runners. */
export function doctorCaseCatalog(plugin?: PluginDefinition, file?: string, cwd = process.cwd()): DoctorCaseSet[] {
  const local = localCaseCatalog(file, cwd);
  return [
    ...[{ id: "core.model", load: () => [MODEL_CASE_SET] }, httpCaseCatalog].flatMap(source =>
      loadCaseCatalog(source).map(caseSet => ({ source: "builtin" as const, caseSet }))),
    ...(plugin?.services.caseSources() ?? []).flatMap(({ service, source }) =>
      loadCaseCatalog(source).map(caseSet => ({ source: "plugin" as const, service: service.name, sourceId: source.id, caseSet }))),
    ...loadCaseCatalog(local).map(caseSet => ({ source: "local" as const, file: local.file, caseSet })),
  ];
}

export function caseMatchesCommand(item: Case, command: DoctorCaseCommand): boolean {
  if (command === "http") return typeof item.input.path === "string"
    && (item.input.protocol === undefined || item.input.protocol === "http")
    && (item.input.body === undefined || typeof item.input.body === "string");
  if (command === "model") return item.input.kind === "performance"
    || (["/chat/completions", "/embeddings", "/rerank"].includes(String(item.input.path))
      && typeof item.input.body === "object" && item.input.body !== null);
  // Perf/Eval must supply the selected runner's protocol contract.
  return false;
}

export interface DoctorCaseSelection {
  source: DoctorCaseSet;
  cases: Case[];
}

export async function selectDoctorCases(input: {
  catalog: readonly DoctorCaseSet[];
  command: DoctorCaseCommand;
  caseSetId?: string;
  caseIds?: string;
  modelType?: string;
  defaultCaseIds?: readonly string[];
  supports?: CaseSupport;
}): Promise<DoctorCaseSelection | undefined> {
  const available = input.catalog.map((source) => ({
    source,
    cases: source.caseSet.cases.filter((item) => (input.supports ?? source.supports ?? ((item: Case) => caseMatchesCommand(item, input.command)))(item)
      && (!input.modelType || !item.facets?.model_type || item.facets.model_type === input.modelType)),
  })).filter((entry) => entry.cases.length > 0);
  if (!available.length) throw new Error(`没有可用于 doctor ${input.command} 的 Case`);
  const requestedSet = input.caseSetId;
  const matchingSets = requestedSet ? available.filter((entry) => entry.source.caseSet.caseset === requestedSet) : [];
  if (matchingSets.length > 1) throw new Error(`CaseSet '${requestedSet}' 同时来自多个来源；请避免重名`);
  let chosen: (typeof available)[number] | undefined = matchingSets[0];
  if (requestedSet && !chosen) throw new Error(`没有可用于 doctor ${input.command} 的 CaseSet '${requestedSet}'`);
  if (!chosen && available.length === 1) chosen = available[0];
  if (!chosen && isInteractive()) {
    printNumberedChoices(available, `[${input.command}] 可选 CaseSet：`, (entry) =>
      `${entry.source.caseSet.caseset} (${entry.source.source}${entry.source.service ? `/${entry.source.service}` : ""})`);
    chosen = await promptListedChoice({
      question: "请选择 CaseSet（编号，q 取消）：",
      match: (answer) => matchListedChoice(available, answer,
        (entry) => entry.source.caseSet.caseset, (entry) => entry),
      invalidMessage: "请输入列表中的 CaseSet 编号或名称。",
    });
    if (!chosen) return undefined;
  }
  if (!chosen) throw new Error(`有 ${available.length} 个可用 CaseSet；请用 --caseset 指定`);
  const requestedIds = input.caseIds?.split(",").map((id) => id.trim()).filter(Boolean);
  if (input.caseIds !== undefined && !requestedIds?.length) throw new Error("--cases 未解析出任何 Case ID");
  const defaults = input.defaultCaseIds ?? (input.command === "eval"
    ? chosen.cases.map((item) => item.id) : [chosen.cases[0]!.id]);
  let ids = requestedIds;
  if (!ids && isInteractive()) {
    ids = await promptMultiSelect({
      choices: chosen.cases.map((item) => ({ name: item.id, description: item.desc })),
      defaults: [...defaults].filter((id) => chosen!.cases.some((item) => item.id === id)),
      title: `[${input.command}] 选择一个或多个 Case`,
    });
    if (!ids) return undefined;
  }
  ids ??= [...defaults].filter((id) => chosen.cases.some((item) => item.id === id));
  if (!ids.length) throw new Error("至少选择一个 Case");
  const byId = new Map(chosen.cases.map((item) => [item.id, item]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`CaseSet '${chosen.source.caseSet.caseset}' 不包含 Case：${unknown.join(", ")}`);
  return { source: chosen.source, cases: [...new Set(ids)].map((id) => byId.get(id)!) };
}
