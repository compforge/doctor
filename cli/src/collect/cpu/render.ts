import { formatContainerResourceUsage } from "../fact/resource-usage";
import type { InspectionMode } from "../inspection";
import type { CpuDiagnosis } from "./model";

export function buildCpuMarkdown(diagnosis: CpuDiagnosis, mode: InspectionMode): string {
  const { facts, observations } = diagnosis.evidence;
  const target = facts.target;
  const stack = observations.find((observation) => observation.kind === "py-spy");
  const lines = [
    `# CPU 诊断摘要：${target ? `${target.pod.namespace}/${target.pod.name}` : "目标未解析"}`,
    "",
    "## Facts",
    "",
    `- mode: ${mode}`,
    `- exec/python3/proc: ${facts.kubernetes?.podsExec ?? false}/${facts.container?.python3 ?? false}/${facts.container?.proc ?? false}`,
    `- pid: ${facts.processScan?.pickedPid ?? "unknown"}`,
    `- ptrace: ${facts.ptrace?.reason ?? "未取得"}`,
    `- py-spy: ${stack ? "已采集" : "未取得（见 coverage / raw 步骤）"}`,
  ];
  if (facts.resourceUsage) {
    lines.push(`- 当前资源：${formatContainerResourceUsage(facts.resourceUsage)}`);
  }
  lines.push("", "## Python 线程栈", "");
  if (!stack) {
    lines.push("本次未取得 py-spy 线程栈；原因见 Facts、coverage 和 raw 步骤输出。");
  } else {
    lines.push(`${stack.threads.length} 个线程${stack.pythonVersion ? `（Python ${stack.pythonVersion}）` : ""}。`);
    if (stack.topFrameGroups.length) {
      lines.push("", "| 栈顶 | 线程数 |", "|---|---:|");
      for (const group of stack.topFrameGroups) {
        lines.push(`| \`${group.frame.func} (${group.frame.file}:${group.frame.line})\` | ${group.threadCount} |`);
      }
    }
    lines.push("", "单次 dump 用于定位当前卡顿/阻塞位置，不等同于持续采样 CPU 火焰图。");
  }
  lines.push("", "## 诊断覆盖度", "");
  for (const coverage of diagnosis.coverage) {
    lines.push(`- ${coverage.goal}: ${coverage.status}`);
    for (const missing of coverage.missingEvidence) lines.push(`  - 缺口：${missing}`);
  }
  return `${lines.join("\n")}\n`;
}
