import type { ServiceDescription } from "@compforge/doctor-plugin";

/** Text and JSON share the same declaration projection; rendering never inspects a live Service. */
export function formatServiceDescription(service: ServiceDescription): string {
  const lines = [`  Service: ${service.name}`, `    说明：${service.description ?? "未提供"}`];
  lines.push(`    Aliases：${service.aliases.join(", ") || "无"}`);
  const { inspect, workloads, dependencies, dataSources, access } = service.details;
  if (inspect) {
    lines.push("    数据查询（Inspect contribution，不是同名 CLI 命令）",
      `      用途：${inspect.description ?? "未提供"}`,
      `      输入 ID（每个 Query 选一种）：${inspect.accepts.join(" / ")}`,
      `      可能提供的事实：${inspect.provides.join(", ")}`,
      `      可能关联的 ID：${inspect.expands?.join(", ") || "未声明"}`);
    if (inspect.dataSource) lines.push(`      DataSource：${inspect.dataSource}`);
    lines.push(`      限制说明：${inspect.limitations?.join("；") || "未提供（不代表无限制）"}`);
  } else {
    lines.push("    数据查询：未声明 Inspect contribution");
  }
  lines.push(`    Capabilities：${service.capabilities.join(", ") || "无"}`,
    `    Contributions：${service.contributions.join(", ") || "无"}`,
    `    DataSources：${dataSources.map(source => `${source.id} (${source.kind}/${source.backend})${source.description ? ` — ${source.description}` : ""}`).join(", ") || "未声明"}`,
    "    Workloads：");
  for (const workload of workloads) {
    const target = workload.discovery.kind === "kubernetes-service"
      ? `service/${workload.discovery.service}`
      : `pods ${JSON.stringify(workload.discovery.labels)}`;
    lines.push(`      ${workload.name} (${workload.lifecycle}): ${target}${workload.container ? `; container=${workload.container}` : ""}`);
  }
  if (!workloads.length) lines.push("      无运行时 Workload");
  lines.push("    依赖：");
  for (const dependency of dependencies) {
    lines.push(`      ${dependency.id}: ${dependency.service}/${dependency.capability}/${dependency.dataSource}`);
  }
  if (!dependencies.length) lines.push("      未声明");
  lines.push("    访问需求（Plugin 静态声明，不包含 Core 的完整访问计划）：");
  for (const item of access) {
    lines.push(`      ${item.owner}:`);
    const rules = item.requirements.kubernetes ?? [];
    for (const { rule, requirement, purpose, fallback } of rules) {
      lines.push(`        ${requirement}: ${rule.verb} ${rule.resource}${rule.resourceName ? `/${rule.resourceName}` : ""}${rule.allNamespaces ? " (all namespaces)" : ""} — ${purpose}${fallback ? `; fallback: ${fallback}` : ""}`);
    }
    if (!rules.length) lines.push("        未声明 Kubernetes 访问需求");
  }
  if (!access.length) lines.push("      未声明");
  lines.push("    以上为能力声明，尚未检查目标环境。可能产出不代表本次查询必然返回。\n");
  return lines.join("\n");
}
