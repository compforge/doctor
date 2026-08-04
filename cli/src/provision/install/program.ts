import {
  matchListedChoice,
  printNumberedChoices,
  promptListedChoice,
} from "../../terminal/selection";
import {
  INSTALL_PROGRAMS,
  type InstallProgram,
} from "./model";

export function parseInstallProgram(value: string): InstallProgram {
  const program = value.trim().toLowerCase();
  if (!INSTALL_PROGRAMS.includes(program as InstallProgram)) {
    throw new Error(`doctor install 目前仅支持安装 ${INSTALL_PROGRAMS.join("、")}`);
  }
  return program as InstallProgram;
}

export async function promptInstallProgram(): Promise<InstallProgram | undefined> {
  printNumberedChoices(INSTALL_PROGRAMS, "[install] 可安装程序：", (program) => program);
  return promptListedChoice({
    question: "请选择要安装的程序（序号或名称，q 取消）：",
    match: (answer) => matchListedChoice(
      INSTALL_PROGRAMS,
      answer,
      (program) => program,
      (program) => program,
    ),
    invalidMessage: `未找到程序，可选：${INSTALL_PROGRAMS.join("、")}`,
  });
}
