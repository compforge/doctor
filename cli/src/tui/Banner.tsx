import boxen from "boxen";
import { Box, Text } from "ink";
import type { Profile } from "../app/config/model";

interface Props {
  version: string;
  profileName: string;
  profile: Profile | undefined;
  connectionId: string;
  resumeConversationId?: string;
  warnings: string[];
}

// 单色 ASCII 听诊器——保留用户手绘轮廓，只做描粗和圆角化：
//  ① 顶部耳塞改成圆形 ◯，并保持朝内相对
//  ② 上半部仍然是单个 U / Y 主轮廓，不做双线或双管
//  ③ 中间接头用短横线强调，但不把体积做得太重
//  ④ 下半部是短竖管 + 右侧回弯，整体高度控制在 7 行
//  ⑤ 听筒用同心圆 ◎，与参考图一致
const LOGO = [
  " ╭─◯   ◯─╮           ",
  "  ╲     ╱            ",
  "   ╲   ╱             ",
  "    ═══              ",
  "     ║     ◎         ",
  "     ║     │         ",
  "     ╰═════╯         ",
];

export function Banner(props: Props) {
  const { version, profile, profileName, connectionId, resumeConversationId, warnings } = props;
  const cidShort = `${connectionId.slice(0, 8)}…`;
  const resumeShort = resumeConversationId
    ? `${resumeConversationId.slice(0, 8)}…`
    : undefined;

  // 把 logo 列 + 信息列拼成 side-by-side 单字符串后丢给 boxen 框起来。
  // 这样对外只输出一个用 \n 隔开的字符串，Ink 拿来作 <Text> 一行行渲染就行——
  // boxen 的 ANSI 输出干净（只有边框字符 + 默认 FG），不会跟 Ink 的布局引擎打架。
  const infoLines: string[] = [
    `profile  ${profileName}`,
    `cid      ${cidShort}`,
  ];
  if (profile?.server) infoLines.push(`server   ${profile.server}`);
  if (profile?.llm?.model) {
    infoLines.push(
      `model    ${profile.llm.provider ?? "?"}/${profile.llm.model}${
        profile.llm.thinking ? " (thinking)" : ""
      }`,
    );
  }
  if (profile?.readonly !== undefined) {
    infoLines.push(`mode     ${profile.readonly ? "readonly" : "read-write"}`);
  }
  if (resumeShort) infoLines.push(`resume   ${resumeShort}`);

  // 把两列对齐成同行数：取较高者，短的一列补空行
  const rows = Math.max(LOGO.length, infoLines.length);
  const composed: string[] = [];
  for (let i = 0; i < rows; i++) {
    const left = LOGO[i] ?? " ".repeat(LOGO[0].length);
    const right = infoLines[i] ?? "";
    composed.push(`${left}  ${right}`);
  }

  // boxen 输出当前不带 SGR 颜色（我们只用 borderStyle 没设 borderColor），无 ANSI
  // 泄露风险。万一以后启用 borderColor / dimBorder，记得在末尾补 `\x1b[0m` 兜底。
  const boxed = boxen(composed.join("\n"), {
    title: `doctor v${version}`,
    titleAlignment: "left",
    borderStyle: "round",
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: 0,
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{boxed}</Text>
      {warnings.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {warnings.map((w, i) => (
            <Text key={i} color="yellow">
              ⚠ {w}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>输入 /help 查看命令；Ctrl+C 退出。</Text>
      </Box>
    </Box>
  );
}
