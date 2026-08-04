import {
  htmlHeading,
  htmlList,
  htmlParagraph,
  htmlTable,
  htmlTableCell,
  type HtmlPieChart,
} from "../output/html";
import type { PyHeapDiagnosis, PyHeapFinding } from "./detector/pyheap";
import type { PyHeapAnalysis } from "./pyheap-analysis";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function renderFinding(finding: PyHeapFinding): string {
  if (finding.kind === "memory.pyheap-type-concentration") {
    const names = finding.dominantTypes.map((type) => type.type_name).join("、");
    return `对象堆 shallow size 集中在 ${names}，合计 ${formatShare(finding.combinedHeapShare)}；`
      + "这是排查优先级，不等于这些类型发生泄漏。";
  }
  if (finding.kind === "memory.pyheap-retained-distributed") {
    const owner = finding.largestOwner;
    return `没有单个对象保留超过对象堆 5%；最大 owner ${owner.type_name}@${owner.object_address} `
      + `保留 ${formatBytes(owner.retained_size_bytes)}（${formatShare(owner.heap_share)}）。`
      + "当前对象图更像分散持有，不能仅凭单个 owner 定位泄漏。";
  }
  if (finding.kind === "memory.pyheap-known-runtime-owner") {
    return `${finding.owner.type_name}@${finding.owner.object_address} 的容器构成和入向引用`
      + `与 ${finding.runtimeOwner} 高度一致；这是 Python import 路径查找器缓存，`
      + "单次快照中的存在或大小不等于泄漏。";
  }
  const top = finding.owners[0]!;
  return `发现 ${finding.owners.length} 个 retained size 至少占对象堆 5% 的 owner；`
    + `首位 ${top.type_name}@${top.object_address} 保留 ${formatBytes(top.retained_size_bytes)}`
    + `（${formatShare(top.heap_share)}）。`;
}

function formatTypeCounts(counts: Array<{ type_name: string; object_count: number }> | undefined): string {
  return counts?.map((item) => `${item.type_name} × ${item.object_count.toLocaleString("en-US")}`).join("、") || "-";
}

function formatContainerProfile(owner: PyHeapAnalysis["retained_heap"]["top_objects"][number]): string {
  const profile = owner.container_profile;
  if (!profile) return "-";
  const parts = [`${profile.item_count.toLocaleString("en-US")} 项`];
  if (profile.key_types) parts.push(`key: ${formatTypeCounts(profile.key_types)}`);
  if (profile.value_types) parts.push(`value: ${formatTypeCounts(profile.value_types)}`);
  if (profile.element_types) parts.push(`element: ${formatTypeCounts(profile.element_types)}`);
  return parts.join("；");
}

function formatInboundPaths(owner: PyHeapAnalysis["retained_heap"]["top_objects"][number]): string {
  return owner.inbound_reference_paths
    ?.map((path) => path.map((node) => node.type_name).join(" → "))
    .join("；") || "-";
}

export function buildPyHeapPieCharts(analysis: PyHeapAnalysis): HtmlPieChart[] {
  const top = analysis.types.slice(0, 8);
  const topBytes = top.reduce((sum, type) => sum + type.shallow_size_bytes, 0);
  const otherBytes = Math.max(0, analysis.heap.shallow_size_bytes - topBytes);
  return [{
    title: "Python 对象 shallow size 构成",
    slices: [
      ...top.map((type) => ({ label: type.type_name, value: type.shallow_size_bytes })),
      ...(otherBytes > 0 ? [{ label: "其它类型", value: otherBytes }] : []),
    ],
  }];
}

export function buildPyHeapAnalysisHtml(
  analysis: PyHeapAnalysis,
  diagnosis: PyHeapDiagnosis,
): string {
  const retainedComplete = analysis.retained_heap.status === "complete";
  const parts = [
    htmlHeading(1, "Python 对象堆诊断"),
    htmlParagraph(
      "本报告描述 dump 时刻捕获到的 Python 对象图。shallow/retained size 不等于进程 RSS；单次快照不能单独证明内存泄漏。",
    ),
    htmlHeading(2, "概览"),
    htmlList([
      `dump 大小: ${formatBytes(analysis.source.size_bytes)}`,
      `对象 shallow size: ${formatBytes(analysis.heap.shallow_size_bytes)}`,
      `对象数: ${analysis.heap.object_count.toLocaleString("en-US")}`,
      `类型数: ${analysis.heap.type_count.toLocaleString("en-US")}`,
      `引用数: ${analysis.heap.referent_count.toLocaleString("en-US")}`,
      `线程数: ${analysis.heap.thread_count}`,
      `retained heap: ${retainedComplete ? "已完成" : "未计算"}`,
      `dump 时间: ${analysis.source.created_at}`,
      `源文件 SHA-256: ${analysis.source.sha256}`,
    ]),
    htmlHeading(2, "Detector 结论"),
    htmlList(diagnosis.findings.length > 0
      ? diagnosis.findings.map(renderFinding)
      : ["当前规则未发现显著的类型集中或 retained owner。"]),
    htmlHeading(2, "诊断覆盖度"),
    htmlTable(
      ["目标", "状态", "缺少证据"],
      diagnosis.coverage.map((coverage) => [
        coverage.goal,
        coverage.status,
        coverage.missingEvidence.join("；") || "-",
      ]),
    ),
    htmlHeading(2, "类型 shallow size Top-N"),
    htmlTable(
      ["类型", "对象数", "shallow size", "对象堆占比"],
      analysis.types.slice(0, 100).map((type) => [
        type.type_name,
        htmlTableCell(type.object_count.toLocaleString("en-US"), type.object_count),
        htmlTableCell(formatBytes(type.shallow_size_bytes), type.shallow_size_bytes),
        htmlTableCell(formatShare(
          analysis.heap.shallow_size_bytes > 0
            ? type.shallow_size_bytes / analysis.heap.shallow_size_bytes
            : 0,
        ), type.shallow_size_bytes),
      ]),
    ),
    htmlHeading(2, "Retained owner Top-N"),
    retainedComplete
      ? htmlTable(
        ["对象", "类型", "shallow size", "retained size", "对象堆占比", "容器画像", "入向引用", "字符串表示"],
        analysis.retained_heap.top_objects.map((owner) => [
          owner.object_address,
          owner.type_name,
          htmlTableCell(formatBytes(owner.shallow_size_bytes), owner.shallow_size_bytes),
          htmlTableCell(formatBytes(owner.retained_size_bytes), owner.retained_size_bytes),
          htmlTableCell(formatShare(
            analysis.heap.shallow_size_bytes > 0
              ? owner.retained_size_bytes / analysis.heap.shallow_size_bytes
              : 0,
          ), owner.retained_size_bytes),
          formatContainerProfile(owner),
          formatInboundPaths(owner),
          owner.string_representation ?? "-",
        ]),
      )
      : htmlParagraph("当前 JSON 来自 summary，未包含 retained heap；需要 retained-heap JSON 才能判断 owner。"),
    htmlHeading(2, "线程与 frame"),
    htmlTable(
      ["线程", "状态", "daemon", "retained size", "frames", "栈顶"],
      analysis.threads.map((thread) => {
        const frame = thread.frames.at(-1);
        return [
          thread.name,
          thread.is_alive ? "alive" : "stopped",
          thread.is_daemon ? "是" : "否",
          htmlTableCell(
            thread.retained_size_bytes === null ? "-" : formatBytes(thread.retained_size_bytes),
            thread.retained_size_bytes ?? -1,
          ),
          thread.frames.length,
          frame ? `${frame.function_name} (${frame.file_name}:${frame.line_number})` : "-",
        ];
      }),
    ),
  ];
  return parts.join("");
}
