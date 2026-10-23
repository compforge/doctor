import type { ComputeIssue, ComputeRead, ComputeQuantity } from "@compforge/harness-toolbox/kubernetes/compute";
import { escapeHtml } from "../report/escape";
import type { ComputeResult, ServiceCompute } from "./flow";

interface Table { title: string; detail?: boolean; headers: string[]; rows: string[][]; notes: string[] }
const decimal = (value: number) => value > 0 && value < 0.001 ? "<0.001" : Number(value.toFixed(3)).toString();
const cpu = (value: number | undefined) => value === undefined ? "未知" : `${decimal(value)} cores`;
const memory = (value: number | undefined) => value === undefined ? "未知" : `${decimal(value / 1024 ** 3)} GiB`;
const quantity = (value: ComputeQuantity | undefined) => [cpu(value?.cpu), memory(value?.memory)];
const coverage = (read: ComputeRead<unknown> | undefined) => !read ? "未采集"
  : read.status === "complete" ? "完整" : read.status === "partial" ? "部分数据" : "不可用";
function issueText(issue: ComputeIssue): string {
  const reason = issue.kind === "permission_denied" ? "无权限"
    : issue.kind === "resource_not_found" ? "资源或指标不可用"
    : issue.kind === "timeout" ? "采集超时" : issue.message;
  return `${issue.source}: ${reason} (${issue.kind}${issue.code === undefined ? "" : `, ${issue.code}`})`;
}
function serviceNotes(service: ServiceCompute): string[] {
  return [...service.discovery.flatMap(discovery => discovery.issues),
    ...(service.compute?.pods.issues ?? []), ...(service.compute?.usage.issues ?? [])].map(issueText);
}

/** @spec Both renderers use acquired evidence only; missing metrics and denied reads never render as zero. */
export function computeTables(result: ComputeResult): Table[] {
  const cluster = result.cluster;
  const tables: Table[] = [{ title: "1. Kubernetes 集群（已观测汇总）", headers: ["项目", "CPU", "内存", "覆盖"], rows: [
    ["总容量 capacity", ...quantity(cluster?.summary.capacity), coverage(cluster?.nodes)],
    ["可分配 allocatable", ...quantity(cluster?.summary.allocatable), coverage(cluster?.nodes)],
    ["已调度 Pod requests", ...quantity(cluster?.summary.pods?.scheduledRequests), coverage(cluster?.pods)],
    ["全部活动 Pod requests（含待调度）", ...quantity(cluster?.summary.pods?.requests), coverage(cluster?.pods)],
    ["Node 实际使用", ...quantity(cluster?.summary.usage), coverage(cluster?.usage)],
  ], notes: [
    `Node: ${cluster?.nodes.status === "unavailable" || !cluster ? "未知" : cluster.nodes.items.length}；Pod: ${cluster?.summary.pods?.pods ?? "未知"}；已调度活动 Pod: ${cluster?.summary.pods?.scheduledPods ?? "未知"}`,
    ...[cluster?.nodes, cluster?.pods, cluster?.usage].flatMap(read => read?.issues.map(issueText) ?? []),
    "可分配容量不是剩余容量。部分数据只描述已观测范围，不能作为完整集群总量。",
  ] }];
  if (cluster?.nodes.items.length) tables.push({ title: "Node 明细", detail: true, headers: ["Node", "Ready", "可调度", "CPU 容量 / 可分配 / 使用", "内存容量 / 可分配 / 使用", "指标时间 / 窗口"],
    rows: cluster.nodes.items.map(node => {
      const usage = cluster.usage.items.find(item => item.name === node.name);
      return [node.name, String(node.ready), String(!node.unschedulable),
        [node.capacity.cpu, node.allocatable.cpu, usage?.cpu].map(cpu).join(" / "),
        [node.capacity.memory, node.allocatable.memory, usage?.memory].map(memory).join(" / "),
        usage ? `${usage.timestamp} / ${usage.window}` : "未知"];
    }), notes: [] });
  tables.push({ title: "2. Service Workload（各 Service 独立汇总）",
    headers: ["Service", "已观测 Pod / Ready", "requests CPU / 内存", "声明 limits CPU / 内存", "实际 CPU / 内存", "覆盖"],
    rows: result.services.map(service => {
      const compute = service.compute, summary = compute?.summary.pods;
      const discoveryPartial = service.discovery.some(item => item.issues.length);
      return [service.service, summary ? `${summary.pods} / ${summary.readyPods}${discoveryPartial ? "（发现不完整）" : ""}` : "未知",
        quantity(summary?.requests).join(" / "), quantity(summary?.configuredLimits).join(" / "), quantity(compute?.summary.usage).join(" / "),
        !service.discovery.length ? "未声明 Workload" : `${discoveryPartial ? "发现不完整；" : ""}Pod ${coverage(compute?.pods)}；指标 ${coverage(compute?.usage)}`];
    }), notes: [
      ...(!result.services.length ? ["没有已加载的 Service；可加载 Plugin 后查看 Workload。"] : []),
      ...result.services.flatMap(service => serviceNotes(service).map(note => `${service.service} · ${note}`)),
      "Service 之间可能共享 Pod，不可相加作为集群总量。每个 Service 内按 namespace / Pod UID 去重；统计整个 Pod，包含 sidecar。",
      "requests 为 spec 声明的资源需求，limits 为已声明值；未设置 limit 的容器可能无上限。已结束 Pod 不计入活动资源汇总。",
      "实际 CPU 为 Metrics API 采样窗口内的核数，内存为 working set；缺失指标显示未知，部分指标仅汇总已取得的样本。",
    ] });
  for (const service of result.services) {
    const pods = service.compute?.pods.items ?? [];
    tables.push({ title: `Service ${service.service} · Pod 明细`, detail: true,
      headers: ["Namespace / Pod", "Workload", "Phase / Ready", "requests CPU / 内存", "声明 limits CPU / 内存", "实际 CPU / 内存", "指标时间 / 窗口"],
      rows: pods.map(pod => {
        const usage = service.compute?.usage.items.find(item => item.namespace === pod.namespace && item.uid === pod.uid);
        const workloads = [...new Set(service.compute?.workloads.filter(item => item.namespace === pod.namespace && item.uid === pod.uid).map(item => item.workload))];
        return [`${pod.namespace}/${pod.name}`, workloads.join(", "), `${pod.phase} / ${pod.ready}`,
          quantity(pod.requests).join(" / "), quantity(pod.configuredLimits).join(" / "), quantity(usage).join(" / "),
          usage ? `${usage.timestamp} / ${usage.window}` : "未知"];
      }), notes: [...serviceNotes(service), ...service.discovery.map(item =>
        `Workload ${item.workload} · namespace=${item.namespace} · 已发现 ${item.instances} 个实例${item.issues.length ? "（发现不完整）" : ""}`),
        ...(service.compute?.summary.pods ? [`未声明 CPU / 内存 limit 的容器数：${service.compute.summary.pods.containersWithoutLimits.cpu} / ${service.compute.summary.pods.containersWithoutLimits.memory}（Pod 级预算仍可能适用）`] : [])] });
  }
  return tables;
}

export function computeText(result: ComputeResult): string {
  return `Compute · ${result.startedAt} · 默认 namespace=${result.namespace}${result.complete ? "" : " · 尚未完成"}\n`
    + computeTables(result).filter(table => !table.detail).map(table => `\n${table.title}\n${table.headers.join(" | ")}\n`
      + table.rows.map(row => row.join(" | ")).join("\n") + "\n"
      + table.notes.map(note => `  ${note}\n`).join("")).join("");
}

export function buildComputeHtml(result: ComputeResult): string {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Doctor Compute</title>
<style>body{font:14px system-ui;margin:32px;color:#17212b}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #d9e0e7;padding:8px;text-align:left;overflow-wrap:anywhere}th{background:#f0f4f8}h2{margin-top:32px}li{margin:6px 0}</style>
<h1>Doctor Compute</h1><p>${escapeHtml(result.startedAt)} · 默认 namespace=${escapeHtml(result.namespace)}${result.complete ? "" : " · 尚未完成"}</p>`
    + computeTables(result).map(table => `<h2>${escapeHtml(table.title)}</h2><table><thead><tr>`
      + table.headers.map(cell => `<th>${escapeHtml(cell)}</th>`).join("") + "</tr></thead><tbody>"
      + table.rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")
      + `</tbody></table><ul>${table.notes.map(note => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`).join("") + "</html>";
}
