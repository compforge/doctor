import boxen from "boxen";

import type { DoctorMeta } from "./model";

const LOGO = [
  " ╭─●     ●─╮",
  " │         │",
  " │         │",
  "  ╲       ╱   ╭───╮",
  "   ╲     ╱    │ ◉ │",
  "    ╲   ╱     ╰─┬─╯",
  "     ╲ ╱        │",
  "      │         │",
  "      ╰─────────╯",
];

export function renderBanner(options: { version: string; meta: DoctorMeta }): string {
  const { version, meta } = options;
  const info = [
    `profile  ${meta.profile_name}`,
    `agent    ${meta.mode}`,
  ];
  if (meta.connection_id) info.push(`cid      ${short(meta.connection_id)}`);
  if (meta.server) info.push(`server   ${meta.server}`);
  if (meta.model) info.push(`model    ${meta.model}`);
  info.push(`mode     ${meta.readonly ? "readonly" : "read-write"}`);
  if (meta.conversation_id) info.push(`resume   ${short(meta.conversation_id)}`);

  // 各行按最大宽度对齐，保证 info 列左缘齐平，不依赖字符串里的尾部空格
  const logoWidth = Math.max(...LOGO.map((line) => line.length));
  const rows = Math.max(LOGO.length, info.length);
  const content = Array.from({ length: rows }, (_, index) => {
    const left = (LOGO[index] ?? "").padEnd(logoWidth);
    return `${left}  ${info[index] ?? ""}`;
  }).join("\n");

  return boxen(content, {
    title: `doctor v${version}`,
    titleAlignment: "left",
    borderStyle: "round",
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: 0,
  });
}

function short(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}
