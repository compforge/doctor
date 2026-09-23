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
import type { KubernetesAutoscaler, KubernetesWorkloadEvent } from "../../infra/k8s/workload-events";

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

function workloadRows(diagnosis: InspectDiagnosis): string[][] {
  if (diagnosis.evidence.facts.serviceTargets.status !== "collected") return [];
  return Object.values(diagnosis.evidence.facts.serviceTargets.services)
    .sort((left, right) => left.service.localeCompare(right.service))
    .flatMap((service) => Object.values(service.workloads).map((workload) => [
      service.service, workload.name, workload.description ?? "—",
    ]));
}

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

function podReady(pod: InspectPodRuntimeFact): boolean {
  return pod.phase === "Running"
    && pod.conditions.some((condition) => condition.type === "Ready" && condition.status === "True")
    && pod.containers.length > 0
    && pod.containers.every((container) => container.ready === true);
}

function compactPodStatus(pod: InspectPodRuntimeFact): string {
  const ready = pod.conditions.find((condition) => condition.type === "Ready");
  return [
    `phase=${pod.phase}`,
    pod.reason ? `reason=${pod.reason}` : undefined,
    ready ? `Ready=${ready.status}${ready.reason ? `(${ready.reason})` : ""}` : "Ready=unknown",
  ].filter((value): value is string => Boolean(value)).join("; ");
}

function compactContainerStatus(container: InspectPodContainerFact): string {
  const state = container.state?.kind === "waiting"
    ? `waiting=${container.state.reason ?? "unknown"}`
    : container.state?.kind === "terminated"
      ? `state=${terminationStatus(container.state)}`
      : container.state?.kind === "running"
        ? "running"
        : "state=unknown";
  return [
    `ready=${container.ready ?? "unknown"}`,
    `restarts=${container.restartCount}`,
    state,
    container.lastTermination ? `last=${terminationStatus(container.lastTermination)}` : undefined,
  ].filter((value): value is string => Boolean(value)).join("; ");
}

interface RuntimeSummaryIssue {
  service: string;
  workload: string;
  pod?: InspectPodRuntimeFact;
  container?: InspectPodContainerFact;
  reason?: string;
}

function runtimeSummaryIssues(diagnosis: InspectDiagnosis): RuntimeSummaryIssue[] {
  if (diagnosis.evidence.facts.serviceTargets.status !== "collected") {
    return [{ service: "—", workload: "—", reason: diagnosis.evidence.facts.serviceTargets.reason }];
  }
  return Object.values(diagnosis.evidence.facts.serviceTargets.services).flatMap<RuntimeSummaryIssue>((service) => (
    Object.values(service.workloads).flatMap<RuntimeSummaryIssue>((workload) => {
      if (workload.podRuntime.status !== "collected") {
        return [{ service: service.service, workload: workload.name, reason: workload.podRuntime.reason }];
      }
      if (!workload.podRuntime.pods.length) return [{ service: service.service, workload: workload.name, reason: "没有发现 Pod" }];
      return workload.podRuntime.pods.flatMap<RuntimeSummaryIssue>((pod) => {
        const podIssue = !podReady(pod);
        const containers = pod.containers.filter((container) => container.ready !== true || container.restartCount > 0 || container.lastTermination !== undefined || container.state?.kind !== "running");
        if (!podIssue && !containers.length) return [];
        return containers.length
          ? containers.map((container) => ({ service: service.service, workload: workload.name, pod, container }))
          : [{ service: service.service, workload: workload.name, pod }];
      });
    })
  ));
}

function lifecycleSignals(diagnosis: InspectDiagnosis): { events: KubernetesWorkloadEvent[]; autoscalers: KubernetesAutoscaler[] } | undefined {
  const fact = diagnosis.evidence.facts.lifecycleSignals;
  return fact.status === "collected" ? fact : undefined;
}

function lifecycleUnavailableReason(diagnosis: InspectDiagnosis): string | undefined {
  const fact = diagnosis.evidence.facts.lifecycleSignals;
  return fact.status === "collected" ? undefined : fact.reason;
}

function formatEvent(event: KubernetesWorkloadEvent): string {
  const message = event.message.length > 120 ? `${event.message.slice(0, 120)}…` : event.message;
  return [
    event.lastAt ?? "未知时间",
    event.type,
    event.reason,
    event.count > 1 ? `×${event.count}` : undefined,
    message ? `— ${message}` : undefined,
  ].filter(Boolean).join(" ");
}

/** 事件按对象名挂在 Pod/Deployment/HPA 上；Pod 级关联只认 Pod 名，避免跨层级误挂。 */
function podEvents(diagnosis: InspectDiagnosis, pod: string, limit = 3): KubernetesWorkloadEvent[] {
  const events = lifecycleSignals(diagnosis)?.events ?? [];
  return events.filter((event) => event.objectKind === "Pod" && event.objectName === pod).slice(-limit);
}

function autoscalerSummaryLines(autoscalers: KubernetesAutoscaler[], unavailable?: string): string[] {
  if (unavailable) return ["", `Autoscaler / 事件：未采集（${unavailable}）`];
  if (!autoscalers.length) return [];
  return ["", "Autoscaler：", ...autoscalers.map((autoscaler) => {
    const metrics = autoscaler.metrics.length ? `；${autoscaler.metrics.join("，")}` : "";
    return `- ${autoscaler.name} → ${autoscaler.targetKind}/${autoscaler.targetName}：`
      + `current=${autoscaler.currentReplicas ?? "?"} desired=${autoscaler.desiredReplicas ?? "?"}`
      + `（min=${autoscaler.minReplicas ?? "?"} max=${autoscaler.maxReplicas ?? "?"}${metrics}）`;
  })];
}

/** Concise runtime projection for terminal triage; the Markdown summary remains the complete human-readable evidence. */
export function buildInspectRuntimeSummary(diagnosis: InspectDiagnosis, namespace: string): string {
  const services = diagnosis.evidence.facts.serviceTargets.status === "collected"
    ? Object.values(diagnosis.evidence.facts.serviceTargets.services)
    : [];
  const workloads = services.flatMap((service) => Object.values(service.workloads));
  // Workload selectors may overlap; count physical Pods while retaining each Workload association below.
  const pods = [...new Map(workloads.flatMap((workload) => workload.podRuntime.status === "collected"
    ? workload.podRuntime.pods.map((pod) => [
      JSON.stringify([pod.instance.environment, pod.instance.namespace, pod.instance.uid || pod.pod]), pod,
    ] as const)
    : [])).values()];
  const readyPods = pods.filter(podReady).length;
  const issues = runtimeSummaryIssues(diagnosis);
  const missing = [
    ...diagnosis.coverage.filter((item) => item.status !== "sufficient")
      .map((item) => `${item.goal}: ${item.status}${item.missingEvidence.length ? ` — ${item.missingEvidence.join("；")}` : ""}`),
    ...services.filter((service) => !Object.keys(service.workloads).length)
      .map((service) => `${service.service}: 未声明 Workload，无法判断运行状态`),
    ...issues.filter((issue) => !issue.pod).map((issue) => `${issue.service}/${issue.workload}: ${issue.reason}`),
  ];
  if (!services.length && !missing.length) missing.push("未取得 Service 运行证据");
  const degraded = pods.some((pod) => !podReady(pod)
    || pod.containers.some((container) => container.state?.kind !== "running"))
    || diagnosis.findings.some((finding) => finding.severity !== "info");
  // Historical restarts remain visible but do not rewrite current readiness; missing evidence cannot prove health.
  const status = degraded ? "degraded" : missing.length ? "unknown" : issues.length ? "warning" : "healthy";
  const lifecycle = lifecycleSignals(diagnosis);
  const autoscalers = lifecycle?.autoscalers ?? [];
  const lifecycleUnavailable = lifecycleUnavailableReason(diagnosis);
  return [
    "Service Inspect 摘要",
    `Namespace：${namespace}`,
    `Service：${services.map((service) => service.service).join(", ") || "—"}`,
    `Workload：${workloads.length}`,
    `Pod：${pods.length} total，${readyPods} ready`,
    `状态：${status}`,
    `证据：${missing.length ? "incomplete" : "complete"}`,
    "",
    "异常实例 / 历史提醒：",
    ...(issues.length ? issues.flatMap((issue) => [
      `- ${issue.service}/${issue.workload}${issue.pod ? `/${issue.pod.pod}` : ""}${issue.container ? ` / ${issue.container.name}` : ""}`,
      ...(issue.reason ? [`  原因：${issue.reason}`] : []),
      ...(issue.pod ? [`  Pod：${compactPodStatus(issue.pod)}`] : []),
      ...(issue.container ? [
        `  Container：${compactContainerStatus(issue.container)}`,
        `  Image：${issue.container.image || "—"}`,
        `  Memory：request=${issue.container.requests.memory ?? "—"}，limit=${issue.container.limits.memory ?? "—"}`,
      ] : []),
      // 探针失败/重启的触发原因在 Event 里（如 liveness 超时），Pod status 只有结果没有原因。
      ...(issue.pod ? podEvents(diagnosis, issue.pod.pod).map((event) => `  关联事件：${formatEvent(event)}`) : []),
    ]) : ["- 无"]),
    "", "近期生命周期事件：",
    ...(lifecycle ? lifecycle.events.slice().sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "")).slice(0, 8)
      .map(event => `- ${event.objectKind}/${event.objectName}：${formatEvent(event)}`) : [`- 未采集：${lifecycleUnavailable}`]),
    ...(lifecycle && !lifecycle.events.length ? ["- 所采窗口内无相关事件"] : []),
    ...(lifecycle && lifecycle.events.length > 8 ? [`- 另有 ${lifecycle.events.length - 8} 条事件，见 summary.md#workload-events`] : []),
    "详细证据：summary.md#workload-pods（Pod / 镜像），summary.md#workload-events（事件）",
    ...autoscalerSummaryLines(autoscalers, lifecycleUnavailable),
    ...(missing.length ? ["", "证据缺口：", ...missing.map((item) => `- ${item}`)] : []),
    ...(diagnosis.findings.length ? ["", "诊断发现：", ...diagnosis.findings.map((finding) =>
      `- [${finding.severity}] ${finding.service}/${finding.kind}: ${finding.message}`)] : []),
    "",
  ].join("\n");
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

const EVENT_TABLE_HEADERS = ["时间", "级别", "对象", "原因", "次数", "消息"] as const;

function eventRows(diagnosis: InspectDiagnosis): string[][] {
  const events = lifecycleSignals(diagnosis)?.events ?? [];
  // 采集侧按时间升序落盘；展示侧最近优先，便于先看触发点。
  return [...events].reverse().map((event) => [
    event.lastAt ?? "—",
    event.type,
    `${event.objectKind}/${event.objectName}`,
    event.reason || "—",
    String(event.count),
    event.message || "—",
  ]);
}

const AUTOSCALER_TABLE_HEADERS = ["HPA", "目标", "当前副本", "期望副本", "min", "max", "指标"] as const;

function autoscalerRows(diagnosis: InspectDiagnosis): string[][] {
  return (lifecycleSignals(diagnosis)?.autoscalers ?? []).map((autoscaler) => [
    autoscaler.name,
    `${autoscaler.targetKind}/${autoscaler.targetName}`,
    String(autoscaler.currentReplicas ?? "—"),
    String(autoscaler.desiredReplicas ?? "—"),
    String(autoscaler.minReplicas ?? "—"),
    String(autoscaler.maxReplicas ?? "—"),
    autoscaler.metrics.join("，") || "—",
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
    "[Pod 与镜像](#workload-pods) · [运行事件](#workload-events) · [原始 Facts](raw/facts.json)",
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
    "### 声明",
    "",
    ...markdownTable(["Service", "Workload", "说明"], workloadRows(diagnosis)),
    "",
    '<a id="workload-pods"></a>',
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
    '<a id="workload-events"></a>',
    "### 运行事件（关联所选 Workload）",
    "",
    ...(lifecycleUnavailableReason(diagnosis)
      ? [`_未采集（${lifecycleUnavailableReason(diagnosis)}）_`]
      : markdownTable([...EVENT_TABLE_HEADERS], eventRows(diagnosis))),
    "",
    "### Autoscaler",
    "",
    ...(lifecycleUnavailableReason(diagnosis)
      ? [`_未采集（${lifecycleUnavailableReason(diagnosis)}）_`]
      : markdownTable([...AUTOSCALER_TABLE_HEADERS], autoscalerRows(diagnosis))),
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
      title: "Workload / 声明",
      html: htmlTable(["Service", "Workload", "说明"], workloadRows(diagnosis)),
    },
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
      title: "Workload / 运行事件",
      html: htmlTable([...EVENT_TABLE_HEADERS], eventRows(diagnosis),
        { search: { column: 2, placeholder: "按对象检索" } }),
    },
    {
      title: "Workload / Autoscaler",
      html: htmlTable([...AUTOSCALER_TABLE_HEADERS], autoscalerRows(diagnosis)),
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
