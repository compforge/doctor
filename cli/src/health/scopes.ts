import { HEALTH_SCOPES, type HealthScope } from "@compforge/doctor-plugin";
export type { HealthScope };
export function healthScopes(value = "all"): readonly HealthScope[] {
  if (value === "all") return HEALTH_SCOPES;
  const selected = value.split(",");
  if (selected.some(scope => !HEALTH_SCOPES.includes(scope as HealthScope))) throw new Error("--scope 必须为 infra、self、deps、biz 的逗号组合或 all");
  return [...new Set(selected)] as HealthScope[];
}
