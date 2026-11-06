export type HealthScope = "self" | "deps" | "business";
export function healthScopes(value = "all"): readonly HealthScope[] {
  if (value === "all") return ["self", "deps", "business"];
  const scopes = value.split(",");
  if (!scopes.length || scopes.some(scope => !["self", "deps", "biz"].includes(scope))) {
    throw new Error("--scope 必须为 self、deps、biz 的逗号组合或 all");
  }
  return [...new Set(scopes)].map(scope => scope === "biz" ? "business" : scope) as HealthScope[];
}

