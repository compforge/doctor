import type { PluginContext } from "@compforge/doctor-plugin";
import type { EvidenceBundle, OutcomeDecl } from "../evidence";
import { makeDataContributionInspect } from "./capability/collect";
import type { PreparedDataCommand, DataCommandContext } from "./context";
import { makeDataInspect } from "./fact/inspect";
import { makeDataPageInspect } from "./page";
import { prepareDataAccess } from "./preparation";
import type { DataProvider } from "./extensions";

export function dataOutcomes(providers: readonly DataProvider[]): OutcomeDecl[] {
  return providers.flatMap(({ name, extension }) => [
    ...(extension.expands?.length ? [{ id: `data-expand-${name}`, title: `${name} 业务 ID 扩展`, risk: "observe" as const }] : []),
    { id: `data-provide-${name}`, title: `${name} 业务数据贡献`, risk: "observe" as const },
  ]);
}

/** Acquisition is shared by Data and Log; selecting evidence output does not gate identity discovery. */
export async function prepareDataInspection(prepared: PreparedDataCommand, bundle: EvidenceBundle,
  log: (line: string) => void, injectedContexts?: Readonly<Record<string, PluginContext>>) {
  const access = await prepareDataAccess(prepared, injectedContexts);
  const ctx: DataCommandContext = { ...prepared, bundle, log,
    pluginContexts: Object.fromEntries(access.confirmed.flatMap(item => item.context ? [[item.service, item.context]] : [])),
  };
  return { ctx, close: access.close, inspects: [
    ...(prepared.config.list ? [makeDataPageInspect(access)] : []),
    makeDataInspect(access), makeDataContributionInspect(prepared),
  ] };
}
