import type { PluginDefinition } from "@compforge/doctor-plugin";
import { promptListedChoice } from "../terminal/selection";
import { promptMultiSelect } from "../terminal/multi-select";
import type { HealthScope } from "./scopes";
import { healthProviders, type HealthProvider } from "./extensions";

export async function selectHealthProviders(
  plugin: PluginDefinition, serviceNames: readonly string[] | undefined, interactive: boolean,
  prompt: typeof promptMultiSelect = promptMultiSelect,
): Promise<HealthProvider[] | undefined> {
  const providers = healthProviders(plugin, serviceNames);
  if (serviceNames || !interactive) return providers;
  const selected = await prompt({
    choices: providers, defaults: providers.map(provider => provider.name),
    title: "选择要体检的 Service（默认全选；非只读请求另行确认）",
  });
  if (!selected?.length) return undefined;
  return providers.filter(provider => selected.includes(provider.name));
}

/** Continuing a scope is separate from authorizing non-readonly Case requests. */
export async function confirmNextHealthScope(
  scope: HealthScope, interactive: boolean,
  prompt: typeof promptListedChoice = promptListedChoice,
): Promise<boolean> {
  if (!interactive) return true;
  const label = scope === "business" ? "biz（业务功能，将按需选择租户和用户）" : "deps（依赖连通性）";
  return await prompt({
    question: `是否继续 ${label} 巡检？[y/N]: `,
    emptyValue: false,
    match: answer => {
      if (/^(y|yes)$/i.test(answer)) return true;
      if (/^(n|no)$/i.test(answer)) return false;
      return undefined;
    },
    invalidMessage: "请输入 y 或 n",
  }) === true;
}
