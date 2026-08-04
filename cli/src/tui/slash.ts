export type SlashResult =
  | { kind: "noop" }
  | { kind: "exit" }
  | { kind: "help" }
  | { kind: "switch_profile"; profileName: string }
  | { kind: "open_profile_picker" }
  | { kind: "export"; path?: string }
  | { kind: "unknown"; raw: string };

export function parseSlash(input: string): SlashResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { kind: "noop" };

  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
  switch (cmd) {
    case "exit":
    case "quit":
      return { kind: "exit" };
    case "help":
      return { kind: "help" };
    case "profile": {
      const name = rest[0];
      // 无参 → 弹下拉让用户挑；带参 → 走老路径直接切
      if (!name) return { kind: "open_profile_picker" };
      return { kind: "switch_profile", profileName: name };
    }
    case "export": {
      const path = rest[0];
      return { kind: "export", path };
    }
    default:
      return { kind: "unknown", raw: trimmed };
  }
}

export const HELP_TEXT = [
  "可用命令：",
  "  /profile         弹出下拉框选 profile",
  "  /profile <name>  直接切到指定 profile（重建 connection，开新对话）",
  "  /export [path]   让 LLM 把当前对话总结成诊断报告并写到本地文件",
  "                   默认 ~/.doctor/exports/<conv>-<ts>.md；会在对话历史里留一条总结请求",
  "  /exit            退出",
  "  /help            显示本帮助",
].join("\n");
