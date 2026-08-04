import cliTruncate from "cli-truncate";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import ms from "ms";

import { inputSummary } from "./tools/inputSummary";

export type ToolStatus = "running" | "success" | "failure";

interface Props {
  toolName: string;
  args: unknown;
  status: ToolStatus;
  result?: string;
  durationMs?: number;
  /** Server-side output was cut at TOOL_RESULT_MAX_CHARS. */
  truncated?: boolean;
  /** Tool hit the execution timeout; value is the timeout limit in ms. */
  timeoutMs?: number;
  /** verbose 模式：args/result 不截断、保留多行原样 */
  verbose?: boolean;
  /**
   * 折叠态预览行覆盖。默认取 result 的第 1 行，但某些工具（如 shell）的第 1 行
   * 是命令回显而不是真正信息——失败时尤其想看 stderr 而不是命令本身。
   * 由专属 ToolView 算出更有信息量的 preview 后传进来。verbose 模式忽略本字段。
   */
  collapsedPreview?: string;
  /**
   * 失败时直接铺开的内容（替代默认的"head + (+N more lines)"折叠）。专属 ToolView
   * （如 shell）可以把工具特有的"已剥离 noise 的核心错误段落"传进来——异常堆栈通常
   * 信息密度高、长度可控，应该默认展开而不是再折叠一次。verbose 模式忽略本字段。
   * 渲染时按 FAILURE_EXPAND_MAX_LINES 行上限截断，超出尾部加 `(+N more lines)`。
   */
  failureExpanded?: string;
}

// 默认截断（按显示宽度，cli-truncate 处理 CJK 双宽字符）
const ARGS_LIMIT = 160;
const RESULT_FIRST_LINE_LIMIT = 280;
const RESULT_BLOCK_LIMIT = 1200;
// 失败展开模式的行/单行长度上限——异常堆栈信息密度高，30 行足以覆盖典型 Python / bash 错误，
// 超长仍走 verbose（-v）查看完整原始输出。
const FAILURE_EXPAND_MAX_LINES = 30;
const FAILURE_EXPAND_LINE_LIMIT = 240;

// tool 名 → 图标。参考 opencode `routes/session/index.tsx`：每个工具一个语义符号，
// 一眼区分 shell vs read vs edit；不在表里的走默认的 ✓/✗。
const TOOL_GLYPH: Record<string, string> = {
  shell: "$",
  bash: "$",
  kubectl: "$",
  read_file: "→",
  read: "→",
  list_dir: "→",
  list: "→",
  write_file: "←",
  write: "←",
  edit: "←",
  grep: "✱",
  search: "✱",
  skill: "◇",
  ask_user_question: "?",
  ask: "?",
  webfetch: "%",
  fetch: "%",
};

export function ToolCard({ toolName, args, status, result, durationMs, truncated, timeoutMs, verbose, collapsedPreview, failureExpanded }: Props) {
  const glyph = TOOL_GLYPH[toolName];
  const finalIcon = glyph ? glyph : status === "failure" ? "✗" : "✓";
  const iconColor =
    status === "failure" ? "red" : status === "running" || glyph ? "cyan" : "green";

  const argsText = inputSummary(toolName, args);
  const argsDisplay = argsText
    ? verbose
      ? argsText
      : cliTruncate(argsText, ARGS_LIMIT)
    : "";

  // Show timeout label instead of duration when the tool hit the timeout limit.
  const durationText =
    status === "running"
      ? ""
      : typeof timeoutMs === "number"
        ? `超时(${timeoutMs / 1000}s)`
        : typeof durationMs === "number" && durationMs > 0
          ? ms(durationMs)
          : "";

  const timeoutColor = typeof timeoutMs === "number" ? ("yellow" as const) : undefined;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={iconColor}>
          {status === "running" ? <Spinner type="dots" /> : finalIcon}
        </Text>
        <Text> </Text>
        <Text bold>{toolName}</Text>
        {argsDisplay ? <Text dimColor>  {argsDisplay}</Text> : null}
        {durationText ? <Text color={timeoutColor} dimColor={!timeoutColor}>  ·  {durationText}</Text> : null}
        {truncated ? <Text color="yellow">  [已截断]</Text> : null}
      </Box>
      {result && status !== "running" ? (
        <Box flexDirection="column" marginLeft={2}>
          {renderResultBlock(result, status, verbose, collapsedPreview, failureExpanded)}
        </Box>
      ) : null}
    </Box>
  );
}

// 多行结果按"首行预览 + 行数提示"展示；verbose 模式直接铺开（限定一个上限避免吞屏）。
// 失败 + 非 verbose + 提供 failureExpanded：直接展开 failureExpanded 内容（按行数上限截断），
// 异常堆栈信息密度高、再折叠一次价值低。
function renderResultBlock(
  result: string,
  status: ToolStatus,
  verbose: boolean | undefined,
  collapsedPreview: string | undefined,
  failureExpanded: string | undefined,
) {
  const lines = result.split("\n");
  const failed = status === "failure";
  if (verbose) {
    const block =
      result.length > RESULT_BLOCK_LIMIT ? cliTruncate(result, RESULT_BLOCK_LIMIT) : result;
    return block.split("\n").map((line, i) => (
      <Text key={i} color={failed ? "red" : undefined} dimColor={!failed}>
        {i === 0 ? "↳ " : "  "}
        {line}
      </Text>
    ));
  }
  if (failed && failureExpanded !== undefined) {
    const allLines = failureExpanded.split("\n");
    const shown = allLines.slice(0, FAILURE_EXPAND_MAX_LINES);
    const overflow = allLines.length - shown.length;
    const nodes = shown.map((line, i) => (
      <Text key={i} color="red">
        {i === 0 ? "↳ " : "  "}
        {cliTruncate(line, FAILURE_EXPAND_LINE_LIMIT)}
      </Text>
    ));
    if (overflow > 0) {
      nodes.push(
        <Text key="overflow" color="red" dimColor>
          {`  (+${overflow} more line${overflow > 1 ? "s" : ""}, -v 看完整输出)`}
        </Text>,
      );
    }
    return nodes;
  }
  const head = collapsedPreview ?? lines[0] ?? "";
  const overflow = lines.length - 1;
  const tail = overflow > 0 ? `  (+${overflow} more line${overflow > 1 ? "s" : ""})` : "";
  return (
    <Text color={failed ? "red" : undefined} dimColor={!failed}>
      ↳ {cliTruncate(head, RESULT_FIRST_LINE_LIMIT)}
      {tail}
    </Text>
  );
}
