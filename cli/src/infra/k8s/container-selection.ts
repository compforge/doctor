import {
  matchListedChoice,
  printNumberedChoices,
  promptListedChoice,
} from "../../terminal/selection";

export interface ContainerChoice {
  name: string;
  image: string;
}

export function printContainerChoices(
  choices: readonly ContainerChoice[],
  pod: string,
): void {
  printNumberedChoices(
    choices,
    `[collect] pod/${pod} 包含多个容器：`,
    (choice) => `${choice.name}${choice.image ? `  image=${choice.image}` : ""}`,
  );
}

export function resolveContainerAnswer(
  choices: readonly ContainerChoice[],
  answer: string,
): string | undefined {
  return matchListedChoice(choices, answer, (choice) => choice.name, (choice) => choice.name);
}

export async function promptContainer(
  choices: readonly ContainerChoice[],
): Promise<string | undefined> {
  return promptListedChoice({
    question: "请选择 Container（序号或名称，q 取消）：",
    match: (answer) => resolveContainerAnswer(choices, answer),
    invalidMessage: "请输入有效的 Container 序号或名称。",
  });
}
