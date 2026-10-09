import type { PluginDefinition } from "@compforge/doctor-plugin";
import { promptMultiSelect } from "../terminal/multi-select";
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
