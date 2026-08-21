import type { Case, CaseSet } from "@compforge/spec-case/model";
import type { PluginDefinition, ServiceDefinition } from "@compforge/doctor-plugin";
import type { EvalCliOpts, EvalConfig } from "./model";

export type EvalProvider = ServiceDefinition & {
  capabilities: ServiceDefinition["capabilities"]
    & Required<Pick<ServiceDefinition["capabilities"], "case">>;
};

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} 必须是正整数`);
  return parsed;
}

function selectedCaseIds(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (!ids.length) throw new Error("--cases 未解析出任何 Case ID");
  return ids;
}

export function evalRunName(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `doctor-eval-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function resolveEvalConfig(opts: EvalCliOpts, now = new Date()): EvalConfig {
  const format = opts.format?.trim();
  if (format && format !== "html" && format !== "bundle") {
    throw new Error(`--format 只支持 html 或 bundle: '${format}'`);
  }
  return {
    service: opts.service?.trim() || undefined,
    caseset: opts.caseset?.trim() || undefined,
    caseIds: selectedCaseIds(opts.cases),
    requestTimeoutMs: positiveInteger(opts.requestTimeout, 180, "--request-timeout") * 1000,
    bundleName: evalRunName(now),
  };
}

export function selectEvalProvider(
  plugin: PluginDefinition,
  requested: string | undefined,
): EvalProvider {
  if (requested) {
    const service = plugin.services.findWith(requested, "case");
    if (!service) throw new Error(`Service '${requested}' 未声明 case capability`);
    return service as EvalProvider;
  }
  const providers = plugin.services.servicesWith("case");
  if (providers.length !== 1) {
    throw new Error(`当前 Plugin 有 ${providers.length} 个 case provider；请使用 --service 指定`);
  }
  return providers[0] as EvalProvider;
}

export function selectEvalCaseSet(
  provider: EvalProvider,
  requested: string | undefined,
): CaseSet {
  if (requested) {
    const caseSet = provider.capabilities.case.caseSets.find((item) => item.caseset === requested);
    if (!caseSet) throw new Error(`Service '${provider.name}' 未声明 CaseSet '${requested}'`);
    return caseSet;
  }
  const caseSets = provider.capabilities.case.caseSets;
  if (caseSets.length !== 1) {
    throw new Error(`Service '${provider.name}' 有 ${caseSets.length} 个 CaseSet；请使用 --caseset 指定`);
  }
  return caseSets[0]!;
}

export function selectEvalCases(caseSet: CaseSet, requested: readonly string[] | undefined): Case[] {
  if (!requested) return [...caseSet.cases];
  const cases = new Map(caseSet.cases.map((item) => [item.id, item]));
  const unknown = requested.filter((id) => !cases.has(id));
  if (unknown.length) {
    throw new Error(`CaseSet '${caseSet.caseset}' 不包含 Case：${unknown.join(", ")}`);
  }
  return requested.map((id) => cases.get(id)!);
}
