import { Box, Text } from "ink";
import type { ToolStatus } from "./ToolCard";
import { pickToolView } from "./tools/registry";

export type HistoryItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; rendered?: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      // 原始 args dict——按 tool 类型决定怎么展示，由 tui/tools/inputSummary.ts 翻译
      args: unknown;
      status: ToolStatus;
      result?: string;
      durationMs?: number;
      truncated?: boolean;
      timeoutMs?: number;
    }
  | { kind: "info"; text: string; tone?: "warn" | "error" | "muted" };

// 单 item 渲染——App.tsx 同时把它丢给 <Static>（committed）和普通 Box（pending）。
// 不再走 <History items={[...]} /> 包装，避免对全数组重渲染。
export function HistoryItemView({
  item,
  verbose,
}: {
  item: HistoryItem;
  verbose?: boolean;
}) {
  switch (item.kind) {
    case "user":
      return (
        <Box>
          <Text color="cyan" bold>
            ›
          </Text>
          <Text> {item.text}</Text>
        </Box>
      );
    case "assistant":
      return <Text>{item.rendered ?? item.text}</Text>;
    case "thinking":
      return <Text dimColor>💭 {item.text}</Text>;
    case "tool": {
      const ToolView = pickToolView(item.toolName);
      return (
        <ToolView
          toolName={item.toolName}
          args={item.args}
          status={item.status}
          result={item.result}
          durationMs={item.durationMs}
          truncated={item.truncated}
          timeoutMs={item.timeoutMs}
          verbose={verbose}
        />
      );
    }
    case "info": {
      const color =
        item.tone === "error" ? "red" : item.tone === "warn" ? "yellow" : undefined;
      const dim = item.tone === "muted";
      return (
        <Text color={color} dimColor={dim}>
          {item.text}
        </Text>
      );
    }
  }
}
