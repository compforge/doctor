import { Box, Text, useStdout } from "ink";
import TextInput from "ink-text-input";

interface Props {
  disabled: boolean;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => void;
}

// 输入区：上下两条横线 ▔ 包夹一行 prompt + 文本输入。借鉴 pi-mono 的视觉，
// 在终端里把"输入区"从对话流里区隔开，避免长滚动后用户找不到光标位置。
export function Input({ disabled, value, onChange, onSubmit }: Props) {
  const { stdout } = useStdout();
  // 终端宽度兜底 80；resize 时 Ink 会自动重渲染，不用手动监听
  const width = Math.max(20, stdout?.columns ?? 80);
  const rule = "▔".repeat(width);

  return (
    <Box flexDirection="column">
      <Text dimColor>{rule}</Text>
      <Box>
        {disabled ? (
          <Text dimColor>(等待回答完成…按 ESC 中断当前 turn)</Text>
        ) : (
          <>
            <Text color="green">› </Text>
            <TextInput
              value={value}
              onChange={onChange}
              onSubmit={(submitted) => {
                if (!submitted.trim()) return;
                onChange("");
                onSubmit(submitted);
              }}
            />
          </>
        )}
      </Box>
      <Text dimColor>{rule}</Text>
    </Box>
  );
}
