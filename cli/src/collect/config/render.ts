import {
  htmlHeading,
  htmlList,
  htmlParagraph,
  htmlTable,
  type HtmlReportSection,
} from "../output/html";
import type { ConfigComparisonRow, ConfigDiagnosis, JsonValue } from "./model";

function displayValue(value: JsonValue | undefined): string {
  if (value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function displayTenantConfig(row: ConfigComparisonRow): string {
  return row.tenantConfig
    ? `${displayValue(row.tenantConfig.value)}\nscope: ${row.tenantConfig.scope}`
    : "—";
}

function markdownCell(value: unknown): string {
  return String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll(/\r?\n/g, "<br>");
}

function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  if (!rows.length) return ["_无配置项_"];
  return [
    `| ${headers.map(markdownCell).join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  ];
}

function tableRows(diagnosis: ConfigDiagnosis): string[][] {
  return diagnosis.evidence.rows.map((row) => [
    row.name,
    displayValue(row.env),
    displayTenantConfig(row),
  ]);
}

const POD_TABLE_HEADERS = [
  "Service",
  "Pod 数量",
  "Pod",
  "Phase",
  "Container",
  "Image（含 tag/digest）",
  "CPU request",
  "CPU limit",
  "Memory request",
  "Memory limit",
] as const;

function podRows(diagnosis: ConfigDiagnosis): string[][] {
  if (diagnosis.evidence.facts.serviceTargets.status !== "collected") return [];
  return Object.values(diagnosis.evidence.facts.serviceTargets.services)
    .sort((left, right) => left.service.localeCompare(right.service))
    .flatMap((target) => {
      if (target.podRuntime.status !== "collected") {
        return [[
          target.service,
          "—",
          `${target.podRuntime.status}: ${target.podRuntime.reason}`,
          "—",
          "—",
          "—",
          "—",
          "—",
          "—",
          "—",
        ]];
      }
      const count = String(target.podRuntime.pods.length);
      if (!target.podRuntime.pods.length) {
        return [[target.service, count, "—", "—", "—", "—", "—", "—", "—", "—"]];
      }
      return target.podRuntime.pods.flatMap((pod) => {
        if (!pod.containers.length) {
          return [[target.service, count, pod.pod, pod.phase, "—", "—", "—", "—", "—", "—"]];
        }
        return pod.containers.map((container) => [
          target.service,
          count,
          pod.pod,
          pod.phase,
          container.name,
          container.image || "—",
          container.requests.cpu ?? "—",
          container.limits.cpu ?? "—",
          container.requests.memory ?? "—",
          container.limits.memory ?? "—",
        ]);
      });
    });
}

function podSummary(diagnosis: ConfigDiagnosis): string {
  if (diagnosis.evidence.facts.serviceTargets.status !== "collected") return "—";
  const targets = Object.values(diagnosis.evidence.facts.serviceTargets.services);
  const pods = new Set(targets.flatMap((target) => target.podRuntime.status === "collected"
    ? target.podRuntime.pods.map((pod) => pod.pod)
    : []));
  return targets.some((target) => target.podRuntime.status !== "collected")
    ? `${pods.size}（部分 Service 未取得）`
    : String(pods.size);
}

function tenantLabel(diagnosis: ConfigDiagnosis): string {
  return diagnosis.evidence.facts.tenantRequest.status === "collected"
    ? `${diagnosis.evidence.facts.tenantRequest.tenantName ?? "未命名"}（${diagnosis.evidence.facts.tenantRequest.tenantId}）`
    : "未选择";
}

function deploymentConfigLabel(diagnosis: ConfigDiagnosis): string {
  const fact = diagnosis.evidence.facts.deploymentConfiguration;
  if (fact.status === "collected") return "已采集";
  return `${fact.status === "failed" ? "不完整" : "未采集"}（${fact.reason}）`;
}

export function buildConfigSummary(diagnosis: ConfigDiagnosis): string {
  const services = diagnosis.evidence.facts.serviceTargets.status === "collected"
    ? Object.keys(diagnosis.evidence.facts.serviceTargets.services).length
    : 0;
  return [
    "# Service 配置统计",
    "",
    `- Service：${services}`,
    `- Pod：${podSummary(diagnosis)}`,
    `- Deployment Env/ConfigMap：${deploymentConfigLabel(diagnosis)}`,
    `- 配置项：${diagnosis.evidence.rows.length}`,
    `- 租户：${tenantLabel(diagnosis)}`,
    "- Env 来源仅包含 ConfigMap 与 Deployment env；Tenant config 由 Plugin 的配置读取能力提供。",
    "",
    "## Coverage",
    "",
    ...diagnosis.coverage.flatMap((item) => [
      `- ${item.goal}：${item.status}`,
      ...item.missingEvidence.map((missing) => `  - 缺失：${missing}`),
    ]),
    "",
    "## Pod 运行态",
    "",
    ...markdownTable(POD_TABLE_HEADERS, podRows(diagnosis)),
    "",
    "## 配置对照",
    "",
    ...markdownTable(["name", "Env（ConfigMap + Deployment env）", "Tenant config"], tableRows(diagnosis)),
  ].join("\n");
}

export function buildConfigHtml(diagnosis: ConfigDiagnosis): string {
  const services = diagnosis.evidence.facts.serviceTargets.status === "collected"
    ? Object.keys(diagnosis.evidence.facts.serviceTargets.services).length
    : 0;
  return [
    htmlHeading(1, "Service 配置统计"),
    htmlList([
      `Service：${services}`,
      `Pod：${podSummary(diagnosis)}`,
      `Deployment Env/ConfigMap：${deploymentConfigLabel(diagnosis)}`,
      `配置项：${diagnosis.evidence.rows.length}`,
      `租户：${tenantLabel(diagnosis)}`,
    ]),
    htmlParagraph("同名配置合并为一行。Env 列来自 ConfigMap 与 Deployment env；Tenant config 列由 Plugin 提供，并在单元格内标明 scope。"),
    htmlParagraph("显式 Deployment env 按 Kubernetes 语义覆盖同名 ConfigMap 值。"),
    htmlHeading(2, "Coverage"),
    htmlList(diagnosis.coverage.flatMap((item) => [
      `${item.goal}：${item.status}`,
      ...item.missingEvidence.map((missing) => `缺失：${missing}`),
    ])),
  ].join("\n");
}

export function buildConfigHtmlSections(diagnosis: ConfigDiagnosis): HtmlReportSection[] {
  return [
    {
      title: "Pod 运行态",
      html: htmlTable(POD_TABLE_HEADERS, podRows(diagnosis)),
    },
    {
      title: "配置对照",
      html: htmlTable(
        ["name", "Env（ConfigMap + Deployment env）", "Tenant config"],
        tableRows(diagnosis),
        { search: { column: 0, placeholder: "按配置名检索" } },
      ),
    },
  ];
}
