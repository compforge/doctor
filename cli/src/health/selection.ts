import { promptMultiSelect } from "../terminal/multi-select";
import { healthScopes } from "./scopes";
import type { HealthProvider } from "./extensions";

/** @spec Scope selection precedes target preparation; cancellation never falls back to all. */
export async function selectHealthScope(scope: string | undefined, interactive: boolean,
  prompt: typeof promptMultiSelect = promptMultiSelect): Promise<string | undefined> {
  if (scope !== undefined || !interactive) return scope ?? "all";
  const selected = await prompt({
    title: "选择体检范围", defaults: ["self", "deps"],
    choices: [
      { name: "self", description: "服务运行状态" },
      { name: "deps", description: "基础依赖可用性（包括 Host S3 读写）" },
      { name: "biz", description: "业务功能（进入时选择 Service）" },
    ],
  });
  if (!selected?.length) return undefined;
  const value = selected.join(",");
  healthScopes(value);
  return value;
}

/** @spec Only biz asks for Services; explicit filters and noninteractive calls keep their resolved candidates. */
export async function selectHealthBusinessProviders(providers: readonly HealthProvider[], interactive: boolean,
  prompt: typeof promptMultiSelect = promptMultiSelect): Promise<readonly HealthProvider[] | undefined> {
  const candidates = providers.filter(provider => provider.consumers.length);
  if (!interactive || !candidates.length) return candidates;
  const selected = await prompt({ choices: candidates, defaults: candidates.map(provider => provider.name),
    title: "选择要检查业务功能的 Service（请求执行前逐项确认）" });
  if (!selected?.length) return undefined;
  return candidates.filter(provider => selected.includes(provider.name));
}
