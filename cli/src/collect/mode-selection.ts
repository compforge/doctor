import { terminalStdout } from "../terminal/output";
import { matchListedChoice, promptListedChoice } from "../terminal/selection";
import type { InspectionMode } from "./inspection";

interface ModeChoice {
  mode: InspectionMode;
  description: string;
}

export const MODE_CHOICES: readonly ModeChoice[] = [
  { mode: "observe", description: "只读观察，不主动改变目标状态" },
  { mode: "overhead", description: "允许受控的诊断负担，影响程度介于 observe 与 disrupt 之间" },
  { mode: "disrupt", description: "可安装工具、创建临时容器或重建 Pod；关键操作仍会逐项确认" },
];

export function printModeChoices(): void {
  terminalStdout.info("[collect] 请选择本次影响等级：\n");
  MODE_CHOICES.forEach((choice, index) => {
    terminalStdout.write(`  ${index + 1}) ${choice.mode}  ${choice.description}\n`);
  });
}

export function matchModeChoice(answer: string): InspectionMode | undefined {
  return matchListedChoice(MODE_CHOICES, answer, (choice) => choice.mode, (choice) => choice.mode);
}

export async function promptMode(): Promise<InspectionMode | undefined> {
  return promptListedChoice({
    question: "请选择 mode（序号或名称，q 取消）：",
    match: matchModeChoice,
    invalidMessage: "输入无效，请输入列表中的序号或 mode 名称。",
  });
}
