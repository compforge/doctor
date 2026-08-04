import { Box, Text } from "ink";

interface Props {
  profileName: string;
  connectionId: string;
  conversationId?: string;
  modelTag: string;
  turnCount: number;
  busy: boolean;
}

// 底部状态栏：profile · cid · model · turn · busy/idle 提示。
// 无 token/cost/context 是有意为之——server 端目前没出 usage 事件，
// 等 SSE 协议补 `usage` 之后再展示流量统计（参考 pi-mono footer 设计）。
export function StatusBar(props: Props) {
  const cidShort = `${props.connectionId.slice(0, 8)}…`;
  const convShort = props.conversationId
    ? `${props.conversationId.slice(0, 8)}…`
    : "—";
  const segments: { text: string; dim?: boolean }[] = [
    { text: props.profileName },
    { text: `cid ${cidShort}`, dim: true },
    { text: `conv ${convShort}`, dim: true },
    { text: props.modelTag },
    { text: `turn ${props.turnCount}`, dim: true },
    { text: props.busy ? "● busy" : "○ idle", dim: !props.busy },
  ];
  return (
    <Box flexDirection="row" marginTop={1}>
      {segments.map((s, i) => (
        <Box key={i} marginRight={2}>
          <Text dimColor={s.dim} color={s.dim ? undefined : "cyan"}>
            {s.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
