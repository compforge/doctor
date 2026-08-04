// /profile 无参时弹出的下拉选择器。
//
// 用 ink-select-input（ink-* 现成包，AGENTS.md §1：优先 ink-* > 通用 npm > 自写）。
// 选中后通过 onSelect 回调把 profile name 抛回 App，由 App 调 session.switchProfile，
// 跟 /profile <name> 走完全相同的下游路径，picker 只解决"输入凭记忆"问题。

import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import type { Profile } from "../app/config/model";

interface Props {
  profiles: Record<string, Profile>;
  currentProfile: string;
  onSelect: (name: string) => void;
  onCancel: () => void;
}

function profileSuffix(p: Profile): string {
  const ro = p.readonly ? "readonly" : "full";
  const llm = p.llm;
  const model = llm?.model
    ? `${llm.provider ?? "?"}/${llm.model}${llm.thinking ? "*" : ""}`
    : "(no model)";
  return `${p.server} · ${ro} · ${model}`;
}

export function ProfilePicker({ profiles, currentProfile, onSelect, onCancel }: Props) {
  const names = Object.keys(profiles);
  // 计算最长 name 宽度，列对齐看起来整齐
  const nameWidth = names.reduce((w, n) => Math.max(w, n.length), 0);
  const items = names.map((name) => {
    const marker = name === currentProfile ? "✓" : " ";
    const padded = name.padEnd(nameWidth, " ");
    return {
      key: name,
      label: `${marker} ${padded}  ${profileSuffix(profiles[name])}`,
      value: name,
    };
  });

  const initialIndex = Math.max(0, names.indexOf(currentProfile));

  // ESC：取消选择回到 input。useInput 跟 ink-select-input 自身的 useInput 是叠加关系，
  // 不会互相吞事件——SelectInput 只消费上下箭头/enter，ESC 漏给我们处理。
  useInput((_, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>选择 profile（↑↓ 移动，Enter 选择，Esc 取消）：</Text>
      <SelectInput
        items={items}
        initialIndex={initialIndex}
        onSelect={(item) => onSelect(String(item.value))}
      />
    </Box>
  );
}
