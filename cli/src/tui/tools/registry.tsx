// 按 tool 名分发到专门的展示组件——参考 opencode `routes/session/index.tsx` 的
// `PART_MAPPING`。当前所有工具都走通用 `ToolCard`（args 一行 + result 多行折叠），
// 但留好接口：将来需要给某个工具做特化展示（比如 edit 出 split-diff、kubectl 出表格、
// shell 高亮 stdout/stderr）时，在这里注册一个组件即可，主流程零改动。
//
// 约定：每个组件接收 `ToolViewProps` —— 等于 ToolCard 的 props。
// 注册一个新组件：
//   1. 在 ./xxxTool.tsx 写一个 React 组件接 `ToolViewProps`
//   2. 在 TOOL_VIEWS 加一行 `{ "<tool_name>": XxxTool }`
//   3. 默认（fallback）继续走 GenericToolView（即原 ToolCard）

import type { ComponentType } from "react";

import { ToolCard, type ToolStatus } from "../ToolCard";
import { ShellToolView } from "./ShellToolView";

export interface ToolViewProps {
  toolName: string;
  args: unknown;
  status: ToolStatus;
  result?: string;
  durationMs?: number;
  truncated?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
}

// 通用兜底——所有未注册专属 view 的工具走这里
export const GenericToolView: ComponentType<ToolViewProps> = ToolCard;

// 注册表：tool 名 → 专属 view。
const TOOL_VIEWS: Record<string, ComponentType<ToolViewProps>> = {
  shell: ShellToolView,
};

export function pickToolView(toolName: string): ComponentType<ToolViewProps> {
  return TOOL_VIEWS[toolName] ?? GenericToolView;
}
