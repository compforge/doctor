// shell 工具专属 view：覆盖默认折叠行为——
// server `harness/tools/shell.py` 的输出格式是
//   `$ <command>\n[exit_code] N\n[stdout]\n...\n[stderr]\n...`，
// 第 1 行是命令回显、含 `[exit_code]/[stdout]/[stderr]` 等结构化标记，
// 通用 ToolCard 默认折叠到首行 → 真正的 stderr 内容根本看不见。
// 这里解析结构化段落，针对失败 / 成功分别给 ToolCard 喂不同的 hint：
//   - 失败：把 stderr（fallback stdout）整段当作 `failureExpanded` 直接铺开（30 行上限），
//     符合"异常堆栈应该默认可见、再折叠一次没价值"的判断。
//   - 成功：维持折叠 + 单行预览，挑 stdout 最后一条非空行（Python traceback 等的关键信息也在最后）。

import type { ComponentType } from "react";

import { ToolCard } from "../ToolCard";
import type { ToolViewProps } from "./registry";

export const ShellToolView: ComponentType<ToolViewProps> = (props) => {
  if (!props.result || props.status === "running") {
    return <ToolCard {...props} />;
  }
  const sections = parseShellSections(props.result);
  if (props.status === "failure") {
    const expanded = sections ? pickFailureBody(sections) : undefined;
    return <ToolCard {...props} failureExpanded={expanded} />;
  }
  // success
  const preview = sections ? pickSuccessPreview(sections) : undefined;
  return <ToolCard {...props} collapsedPreview={preview} />;
};

interface ShellSections {
  stdout: string[];
  stderr: string[];
}

// 解析 shell.py 的 content 格式。结构不匹配时返回 undefined，让 ToolCard 退回默认行为。
export function parseShellSections(result: string): ShellSections | undefined {
  const lines = result.split("\n");
  const stdoutIdx = lines.indexOf("[stdout]");
  const stderrIdx = lines.indexOf("[stderr]");
  if (stdoutIdx < 0 || stderrIdx < 0 || stderrIdx < stdoutIdx) return undefined;
  return {
    stdout: lines.slice(stdoutIdx + 1, stderrIdx),
    stderr: lines.slice(stderrIdx + 1),
  };
}

// 失败时直接展开的内容：优先 stderr，空则 stdout，再空则给个占位字符串。
// 去掉 shell.py 的 `<empty>` 占位行（stdout/stderr 任一为空时它会显式写这个字符串）。
export function pickFailureBody(sections: ShellSections): string {
  const stderr = stripEmptyMarker(sections.stderr);
  if (stderr.length > 0) return stderr.join("\n");
  const stdout = stripEmptyMarker(sections.stdout);
  if (stdout.length > 0) return stdout.join("\n");
  return "(no stderr/stdout output)";
}

// 成功时折叠预览：取 stdout 最后一条非空行；空则给占位字符串。
export function pickSuccessPreview(sections: ShellSections): string {
  const tail = lastInformativeLine(sections.stdout);
  return tail ?? "(no output)";
}

function stripEmptyMarker(lines: string[]): string[] {
  // 单独一行 `<empty>` 是 shell.py 的"段为空"占位；去掉前后空行后若只剩它，视为空段。
  const trimmed = trimBlankEdges(lines);
  if (trimmed.length === 1 && trimmed[0].trim() === "<empty>") return [];
  return trimmed;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

function lastInformativeLine(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed === "<empty>") continue;
    return lines[i];
  }
  return undefined;
}
