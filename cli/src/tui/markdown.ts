import { highlight } from "cli-highlight";
import { Marked } from "marked";
// @ts-expect-error marked-terminal has no bundled types
import { markedTerminal } from "marked-terminal";

// 决定不上 marked-shiki + shiki 的原因：
// shiki 主战场是 HTML 渲染（Web console / GitHub-like 代码块），输出是 `<span>` + 内联 CSS。
// 我们要的是终端 ANSI 着色，shiki 那条路得手写 token→ANSI 转换器。`cli-highlight` 是
// 多年面向终端的 highlight.js wrapper，按语言名直接出 ANSI 颜色，跟 marked-terminal 无缝
// 配合——markdown 段落、列表、bold/italic/链接走 marked-terminal；```code``` 块由
// markedTerminal 的 highlight option 委托给 cli-highlight。
const marked = new Marked();
marked.use(
  markedTerminal({
    code: highlightWithFallback,
  }) as never,
);

export function renderMarkdown(text: string): string {
  if (!text) return "";
  try {
    const out = marked.parse(text);
    if (typeof out !== "string") return text;
    // 显式补 ANSI reset——marked-terminal / cli-highlight 一般会自己 reset 收尾，
    // 但 ASCII art 里曾踩过"末尾没 reset 导致 SGR 泄露到下一个 Ink 节点"的坑，
    // 统一在 sink 处补一遍 `\x1b[0m` 兜底，不会重复。
    return `${out.trimEnd()}\x1b[0m`;
  } catch {
    return text;
  }
}

function highlightWithFallback(code: string, lang: string | undefined): string {
  const trimmed = (lang ?? "").trim();
  try {
    if (trimmed) return highlight(code, { language: trimmed, ignoreIllegals: true });
    return highlight(code, { ignoreIllegals: true });
  } catch {
    return code;
  }
}
