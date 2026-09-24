import type { Case, CaseSet } from "@compforge/spec-case/model";
import {
  CASE_CATALOG_KIND, CASE_RUNNER_CREATE_KIND, loadCaseCatalog,
  requireCaseCatalogExtension, requireCaseRunnerCreateExtension,
  type CaseCatalogExtension, type PluginDefinition, type RegisteredExtension,
} from "@compforge/doctor-plugin";
import { isInteractive } from "../terminal/policy";
import { promptMultiSelect } from "../terminal/multi-select";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "../terminal/selection";
import { createDoctorExtensionRegistry } from "../plugin/extension-registry";
import { localCaseCatalogExtension } from "./local";

export type DoctorCaseCommand = "http" | "model" | "perf";

export interface DoctorCaseSet {
  source: "builtin" | "plugin" | "local";
  service?: string;
  file?: string;
  caseSet: CaseSet;
}

/** Normalize old runner assets at registration, keeping command selection facet-only. */
function legacyRunnerCatalog(runner: RegisteredExtension): CaseCatalogExtension {
  return {
    id: `legacy.${runner.id}`, kind: CASE_CATALOG_KIND,
    load: () => (requireCaseRunnerCreateExtension(runner).caseSets ?? []).map((caseSet) => {
      const cases = caseSet.cases.map((item) => ({
        ...item, facets: { ...item.facets, command: item.facets?.command ?? "perf" },
      }));
      return {
        ...caseSet,
        facets: { ...caseSet.facets, command: { values: [...new Set(cases.map((item) => item.facets.command))] } },
        cases,
      };
    }),
  };
}

/** One registry discovers Core, Plugin and local providers without opening target access. */
export function doctorCaseCatalog(plugin?: PluginDefinition, file?: string, cwd = process.cwd()): DoctorCaseSet[] {
  const local = localCaseCatalogExtension(file, cwd);
  const declared = plugin?.extensions?.some((item) => item.kind === CASE_CATALOG_KIND)
    || Boolean(plugin?.services.extensions(CASE_CATALOG_KIND).length);
  const adapters = !declared ? (plugin?.services.extensions(CASE_RUNNER_CREATE_KIND) ?? []).map(({ service, extension }) => ({
    owner: `service:${service.name}`, extension: legacyRunnerCatalog(extension),
  })) : [];
  const registry = createDoctorExtensionRegistry(plugin, [local], adapters);
  return registry.extensions(CASE_CATALOG_KIND).flatMap(({ owner, extension }) =>
    loadCaseCatalog(requireCaseCatalogExtension(extension)).map((caseSet) => ({
      source: owner === "core" ? "builtin" as const : owner === "local" ? "local" as const : "plugin" as const,
      ...(owner.startsWith("service:") ? { service: owner.slice("service:".length) } : {}),
      ...(owner === "local" && local.file ? { file: local.file } : {}),
      caseSet,
    })));
}

export function caseMatchesCommand(item: Case, command: DoctorCaseCommand): boolean {
  const facet = item.facets?.command;
  return facet === command || facet === "both";
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
}): Promise<DoctorCaseSelection | undefined> {
  const available = input.catalog.map((source) => ({
    source,
    cases: source.caseSet.cases.filter((item) => caseMatchesCommand(item, input.command)
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
  let ids = requestedIds;
  if (!ids && isInteractive()) {
    ids = await promptMultiSelect({
      choices: chosen.cases.map((item) => ({ name: item.id, description: item.desc })),
      defaults: [...(input.defaultCaseIds ?? [chosen.cases[0]!.id])].filter((id) => chosen!.cases.some((item) => item.id === id)),
      title: `[${input.command}] 选择一个或多个 Case`,
    });
    if (!ids) return undefined;
  }
  ids ??= [...(input.defaultCaseIds ?? [chosen.cases[0]!.id])].filter((id) => chosen.cases.some((item) => item.id === id));
  if (!ids.length) throw new Error("至少选择一个 Case");
  const byId = new Map(chosen.cases.map((item) => [item.id, item]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`CaseSet '${chosen.source.caseSet.caseset}' 不包含 Case：${unknown.join(", ")}`);
  return { source: chosen.source, cases: [...new Set(ids)].map((id) => byId.get(id)!) };
}
