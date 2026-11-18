import type { Case, CaseSet } from "@compforge/spec-case/model";
import { loadCaseCatalog, type CaseSupport, type PluginDefinition, type ServiceCaseSource } from "@compforge/doctor-plugin";
import { localCaseCatalog } from "./local";

export type DoctorCaseCommand = "http" | "perf" | "eval";

export interface DoctorCaseSet {
  source: "plugin" | "local";
  service: string;
  sourceId?: string;
  supports?: CaseSupport;
  previewHttp?: ServiceCaseSource["previewHttp"];
  file?: string;
  caseSet: CaseSet;
}

/**
 * @spec Every catalog entry has an owning Service; Core never registers unbound built-in Cases.
 * @why Shared SDK templates become product Cases only when a Service contributes them.
 */
export function doctorCaseCatalog(plugin?: PluginDefinition, file?: string, cwd = process.cwd(), localService?: string): DoctorCaseSet[] {
  const contributed = (plugin?.services.caseSources() ?? []).flatMap(({ service, source }) =>
    loadCaseCatalog(source).map(caseSet => ({ source: "plugin" as const, service: service.name, sourceId: source.id, previewHttp: source.previewHttp, caseSet })));
  const local = localCaseCatalog(file, cwd);
  const sets = loadCaseCatalog(local);
  if (!sets.length) return contributed;
  const owner = localService ? plugin?.services.find(localService)
    : plugin?.services.services.length === 1 ? plugin.services.services[0] : undefined;
  if (!owner) throw new Error("本地 Case 文件必须归属一个已声明的 Service；请用 --service 指定");
  return [...contributed, ...sets.map(caseSet => ({ source: "local" as const, service: owner.name, file: local.file, caseSet }))];
}

export function caseMatchesCommand(item: Case, command: DoctorCaseCommand): boolean {
  if (command === "http") return typeof item.input.path === "string"
    && (item.input.protocol === undefined || item.input.protocol === "http")
    && (item.input.body === undefined || typeof item.input.body === "string")
    && (item.input.protocol !== "http" || Object.keys(item.judge?.e2e ?? {}).every(key => key === "http"));
  // Perf/Eval must supply the selected runner's protocol contract.
  return false;
}

export interface DoctorCaseSelection {
  source: DoctorCaseSet;
  cases: Case[];
}
