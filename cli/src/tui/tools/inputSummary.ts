// 工具参数摘要——按 tool 名挑关键字段，避免一坨 JSON 在历史区刷屏。
//
// 例：
//   shell  {"command":"kubectl get pods","timeout":30}  →  shell  kubectl get pods
//   read_file  {"path":"/app/skills/...","limit":2000}  →  read_file  /app/skills/...
//   skill  {"name":"as-ops"}                            →  skill  as-ops
//
// 新增 tool 在这里加一行；未识别 tool 走 default 兜底（紧凑 JSON）。
// 参考 opencode `routes/session/index.tsx` 的 `input(tool)` helper 思路。

export function inputSummary(toolName: string, args: unknown): string {
  if (args == null) return "";
  if (typeof args !== "object") return String(args);
  const a = args as Record<string, unknown>;
  switch (toolName) {
    case "shell":
    case "bash":
    case "kubectl":
      return string(a.command);
    case "read_file":
    case "read":
      return string(a.path);
    case "list_dir":
    case "list":
      return string(a.path ?? a.dir);
    case "write_file":
    case "write":
    case "edit":
      return string(a.path);
    case "grep":
    case "search":
      return [string(a.pattern), string(a.path)].filter(Boolean).join("  in  ");
    case "skill":
      return string(a.name ?? a.skill);
    case "ask_user_question":
    case "ask":
      return string(a.question);
    default:
      return safeJson(args);
  }
}

function string(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return safeJson(v);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
