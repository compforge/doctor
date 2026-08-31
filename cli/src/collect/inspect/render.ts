import {
  htmlHeading,
  htmlList,
  htmlParagraph,
  htmlTable,
  type HtmlReportSection,
} from "../output/html";
import type {
  DependencyInventoryObservation,
  InspectContainerTerminationFact,
  InspectDiagnosis,
  InspectPodContainerFact,
  InspectPodRuntimeFact,
  JsonValue,
  KubernetesAppArmorAdmissionObservation,
  PluginWorkloadObservation,
} from "./model";

function displayValue(value: JsonValue | undefined): string {
  if (value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
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

function tableRows(diagnosis: InspectDiagnosis): string[][] {
  return diagnosis.evidence.rows.map((row) => [
    row.name,
    displayValue(row.env),
  ]);
}

const POD_TABLE_HEADERS = [
  "Service",
  "Workload",
  "Pod 数量",
  "Pod",
  "ServiceAccount",
  "Pod 状态",
  "Container",
  "Container 状态",
  "Image（含 tag/digest）",
  "CPU request",
  "CPU limit",
  "Memory request",
  "Memory limit",
] as const;

function podStatus(pod: InspectPodRuntimeFact): string {
  const conditions = pod.conditions
    .filter((condition) => condition.type === "Ready" || condition.status !== "True")
    .map((condition) => [
      `${condition.type}=${condition.status}`,
      condition.reason,
      condition.message,
    ].filter(Boolean).join(": "));
  return [
    `phase=${pod.phase}`,
    pod.reason ? `reason=${pod.reason}` : undefined,
    pod.message,
    ...conditions,
  ].filter((line): line is string => !!line).join("\n");
}

function terminationStatus(termination: InspectContainerTerminationFact): string {
  const result = [
    termination.reason,
    termination.exitCode !== undefined ? `exit=${termination.exitCode}` : undefined,
    termination.signal !== undefined ? `signal=${termination.signal}` : undefined,
  ].filter(Boolean).join(", ");
  return `terminated${result ? `: ${result}` : ""}`;
}

function containerStatus(container: InspectPodContainerFact): string {
  const state = container.state?.kind === "waiting"
    ? ["waiting", container.state.reason].filter(Boolean).join(": ")
    : container.state?.kind === "running"
      ? "running"
      : container.state?.kind === "terminated"
        ? terminationStatus(container.state)
        : "unknown";
  const stateMessage = container.state?.kind === "waiting" || container.state?.kind === "terminated"
    ? container.state.message
    : undefined;
  return [
    container.ready === undefined ? undefined : `ready=${container.ready}`,
    `restarts=${container.restartCount}`,
    state,
    stateMessage,
    container.lastTermination ? `last=${terminationStatus(container.lastTermination)}` : undefined,
    container.lastTermination?.message,
  ].filter((line): line is string => !!line).join("\n");
}

function podRows(diagnosis: InspectDiagnosis): string[][] {
  if (diagnosis.evidence.facts.serviceTargets.status !== "collected") return [];
  return Object.values(diagnosis.evidence.facts.serviceTargets.services)
    .sort((left, right) => left.service.localeCompare(right.service))
    .flatMap((target) => Object.values(target.workloads).flatMap((workload) => {
      if (workload.podRuntime.status !== "collected") {
        return [[
          target.service,
          workload.name,
          "—",
          `${workload.podRuntime.status}: ${workload.podRuntime.reason}`,
          "—",
          "—",
          "—",
          "—",
          "—",
          "—",
          "—",
          "—",
          "—",
        ]];
      }
      const count = String(workload.podRuntime.pods.length);
      if (!workload.podRuntime.pods.length) {
        return [[target.service, workload.name, count, "—", "—", "—", "—", "—", "—", "—", "—", "—", "—"]];
      }
      return workload.podRuntime.pods.flatMap((pod) => {
        if (!pod.containers.length) {
          return [[
            target.service,
            workload.name,
            count,
            pod.pod,
            pod.serviceAccountName,
            podStatus(pod),
            "—",
            "—",
            "—",
            "—",
            "—",
            "—",
            "—",
          ]];
        }
        return pod.containers.map((container) => [
          target.service,
          workload.name,
          count,
          pod.pod,
          pod.serviceAccountName,
          podStatus(pod),
          container.name,
          containerStatus(container),
          container.image || "—",
          container.requests.cpu ?? "—",
          container.limits.cpu ?? "—",
          container.requests.memory ?? "—",
          container.limits.memory ?? "—",
        ]);
      });
    }));
}

function podSummary(diagnosis: InspectDiagnosis): string {
  if (diagnosis.evidence.facts.serviceTargets.status !== "collected") return "—";
  const targets = Object.values(diagnosis.evidence.facts.serviceTargets.services);
  const workloads = targets.flatMap((target) => Object.values(target.workloads));
  const pods = new Set(workloads.flatMap((workload) => workload.podRuntime.status === "collected"
    ? workload.podRuntime.pods.map((pod) => pod.pod)
    : []));
  return workloads.some((workload) => workload.podRuntime.status !== "collected")
    ? `${pods.size}（部分 Service 未取得）`
    : String(pods.size);
}

function deploymentConfigLabel(diagnosis: InspectDiagnosis): string {
  const fact = diagnosis.evidence.facts.deploymentConfiguration;
  if (fact.status === "collected") return "已采集";
  return `${fact.status === "failed" ? "不完整" : "未采集"}（${fact.reason}）`;
}

function dependencyObservations(diagnosis: InspectDiagnosis): DependencyInventoryObservation[] {
  return diagnosis.evidence.observations.filter(
    (item): item is DependencyInventoryObservation => item.kind === "dependency-inventory",
  );
}

function dependencyLabel(diagnosis: InspectDiagnosis): string {
  const targets = diagnosis.evidence.facts.dependencyTargets;
  if (targets.status !== "collected") return `未采集（${targets.reason}）`;
  const observations = dependencyObservations(diagnosis);
  const collected = observations.filter((item) => item.status === "collected").length;
  if (collected === targets.targets.length && !targets.missing.length) return `已采集 ${collected} 个镜像`;
  return `已采集 ${collected}/${targets.targets.length} 个镜像`;
}

function appArmorObservations(diagnosis: InspectDiagnosis): KubernetesAppArmorAdmissionObservation[] {
  return diagnosis.evidence.observations.filter(
    (item): item is KubernetesAppArmorAdmissionObservation => (
      item.kind === "kubernetes-apparmor-unconfined-admission"
    ),
  );
}

function appArmorLabel(diagnosis: InspectDiagnosis): string {
  const observations = appArmorObservations(diagnosis);
  if (!observations.length) return "未探测到（best effort）";
  const denied = observations.filter((item) => item.status === "denied").length;
  return denied ? `${denied} 个 ServiceAccount 被拒绝` : `${observations.length} 个 ServiceAccount 允许`;
}

function appArmorRows(diagnosis: InspectDiagnosis): string[][] {
  return appArmorObservations(diagnosis).map((observation) => [
    observation.service,
    observation.namespace,
    observation.serviceAccountName,
    observation.status,
    observation.reason ?? "—",
  ]);
}

function workloadProbeObservations(diagnosis: InspectDiagnosis): PluginWorkloadObservation[] {
  return diagnosis.evidence.observations.filter(
    (item): item is PluginWorkloadObservation => item.kind === "plugin-workload",
  );
}

function workloadProbeRows(diagnosis: InspectDiagnosis): string[][] {
  return workloadProbeObservations(diagnosis).map((observation) => [
    observation.service,
    observation.workload,
    observation.pod,
    observation.probe,
    observation.observationKind,
    JSON.stringify(observation.value),
  ]);
}

function findingRows(diagnosis: InspectDiagnosis): string[][] {
  return diagnosis.findings.map((finding) => [
    finding.severity,
    finding.kind,
    finding.message,
  ]);
}

const TOOLCHAIN_TABLE_HEADERS = [
  "Service",
  "Language",
  "Execution platform",
  "Dependency manager",
  "Build tool",
  "Config capability",
] as const;

function toolchainRows(diagnosis: InspectDiagnosis): string[][] {
  if (diagnosis.evidence.facts.serviceTargets.status !== "collected") return [];
  return Object.values(diagnosis.evidence.facts.serviceTargets.services)
    .sort((left, right) => left.service.localeCompare(right.service))
    .map((target) => [
      target.service,
      target.toolchain?.language ?? "未声明",
      target.toolchain?.executionPlatform ?? "—",
      target.toolchain?.dependencyManager ?? "—",
      target.toolchain?.buildTool ?? "—",
      target.configurationSupported ? "支持" : "未声明",
    ]);
}

const DEPENDENCY_TABLE_HEADERS = [
  "Service",
  "Runtime version",
  "Dependency",
  "Version",
] as const;

function dependencyRows(diagnosis: InspectDiagnosis): string[][] {
  return dependencyObservations(diagnosis).flatMap((observation) => {
    const prefix = [
      observation.services.join(", "),
      observation.runtimeVersion ?? "—",
    ];
    if (observation.status !== "collected") {
      return [[...prefix, `unavailable: ${observation.reason ?? "采集失败"}`, "—"]];
    }
    if (!observation.dependencies.length) return [[...prefix, "（未发现依赖）", "—"]];
    return observation.dependencies.map((dependency) => [
      ...prefix,
      dependency.name,
      dependency.version ?? "—",
    ]);
  });
}

export function buildInspectSummary(diagnosis: InspectDiagnosis): string {
  const services = diagnosis.evidence.facts.serviceTargets.status === "collected"
    ? Object.keys(diagnosis.evidence.facts.serviceTargets.services).length
    : 0;
  return [
    "# Service Inspect",
    "",
    `- Service：${services}`,
    `- Pod：${podSummary(diagnosis)}`,
    `- Deployment Env/ConfigMap：${deploymentConfigLabel(diagnosis)}`,
    `- 应用依赖：${dependencyLabel(diagnosis)}`,
    `- AppArmor Unconfined：${appArmorLabel(diagnosis)}`,
    `- 配置项：${diagnosis.evidence.rows.length}`,
    "- Env 来源仅包含 ConfigMap 与 Deployment env。",
    "- AppArmor admission 使用 workload ServiceAccount 做 server-side dry-run；不会创建 Pod，也不验证节点运行时。",
    "",
    "## Coverage",
    "",
    ...diagnosis.coverage.flatMap((item) => [
      `- ${item.goal}：${item.status}`,
      ...item.missingEvidence.map((missing) => `  - 缺失：${missing}`),
    ]),
    "",
    "## Workload",
    "",
    "### Pod 运行态",
    "",
    ...markdownTable(POD_TABLE_HEADERS, podRows(diagnosis)),
    "",
    "### Toolchain",
    "",
    ...markdownTable(TOOLCHAIN_TABLE_HEADERS, toolchainRows(diagnosis)),
    "",
    "### AppArmor Unconfined admission（best effort）",
    "",
    ...markdownTable(
      ["Service", "Namespace", "ServiceAccount", "Admission", "Reason"],
      appArmorRows(diagnosis),
    ),
    "",
    "### Plugin Workload 探测",
    "",
    ...markdownTable(
      ["Service", "Workload", "Pod", "Probe", "Kind", "Value"],
      workloadProbeRows(diagnosis),
    ),
    "",
    "### Findings",
    "",
    ...markdownTable(["Severity", "Kind", "Message"], findingRows(diagnosis)),
    "",
    "### 应用依赖",
    "",
    ...markdownTable(DEPENDENCY_TABLE_HEADERS, dependencyRows(diagnosis)),
    "",
    "## 配置",
    "",
    "### 配置对照",
    "",
    ...markdownTable(["name", "Env（ConfigMap + Deployment env）"], tableRows(diagnosis)),
  ].join("\n");
}

export function buildInspectHtml(diagnosis: InspectDiagnosis): string {
  const services = diagnosis.evidence.facts.serviceTargets.status === "collected"
    ? Object.keys(diagnosis.evidence.facts.serviceTargets.services).length
    : 0;
  return [
    htmlHeading(1, "Service Inspect"),
    htmlList([
      `Service：${services}`,
      `Pod：${podSummary(diagnosis)}`,
      `Deployment Env/ConfigMap：${deploymentConfigLabel(diagnosis)}`,
      `应用依赖：${dependencyLabel(diagnosis)}`,
      `AppArmor Unconfined：${appArmorLabel(diagnosis)}`,
      `配置项：${diagnosis.evidence.rows.length}`,
    ]),
    htmlParagraph("同名配置合并为一行。Env 列来自 ConfigMap 与 Deployment env。"),
    htmlParagraph("显式 Deployment env 按 Kubernetes 语义覆盖同名 ConfigMap 值。"),
    htmlParagraph("Toolchain 来自 Plugin 声明；依赖清单与 runtime version 来自本次 Target 观测。"),
    htmlParagraph("AppArmor admission 使用 workload ServiceAccount 做 server-side dry-run；不会创建 Pod，也不验证节点运行时。"),
    htmlHeading(2, "Coverage"),
    htmlList(diagnosis.coverage.flatMap((item) => [
      `${item.goal}：${item.status}`,
      ...item.missingEvidence.map((missing) => `缺失：${missing}`),
    ])),
  ].join("\n");
}

export function buildInspectHtmlSections(diagnosis: InspectDiagnosis): HtmlReportSection[] {
  return [
    {
      title: "Workload / Pod 运行态",
      html: htmlTable(POD_TABLE_HEADERS, podRows(diagnosis)),
    },
    {
      title: "Workload / Toolchain",
      html: htmlTable(TOOLCHAIN_TABLE_HEADERS, toolchainRows(diagnosis)),
    },
    {
      title: "Workload / Plugin 探测",
      html: htmlTable(
        ["Service", "Workload", "Pod", "Probe", "Kind", "Value"],
        workloadProbeRows(diagnosis),
      ),
    },
    {
      title: "Findings",
      html: htmlTable(["Severity", "Kind", "Message"], findingRows(diagnosis)),
    },
    {
      title: "Workload / AppArmor Unconfined admission（best effort）",
      html: htmlTable(
        ["Service", "Namespace", "ServiceAccount", "Admission", "Reason"],
        appArmorRows(diagnosis),
      ),
    },
    {
      title: "Workload / 应用依赖",
      html: htmlTable(
        DEPENDENCY_TABLE_HEADERS,
        dependencyRows(diagnosis),
        { search: { column: 2, placeholder: "按依赖名检索" } },
      ),
    },
    {
      title: "配置 / 配置对照",
      html: htmlTable(
        ["name", "Env（ConfigMap + Deployment env）"],
        tableRows(diagnosis),
        { search: { column: 0, placeholder: "按配置名检索" } },
      ),
    },
  ];
}
