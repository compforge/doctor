import {
  matchListedChoice,
  printNumberedChoices,
  promptListedChoice,
} from "../../terminal/selection";
import { podSelectionLabel, type PodSelectionContext } from "./pod-selection";

export interface ContainerChoice {
  name: string;
  image: string;
}

export function printContainerChoices(
  choices: readonly ContainerChoice[],
  pod: string,
  selection: PodSelectionContext,
): void {
  printNumberedChoices(
    choices,
    `[collect] ${selection.purpose}，请选择 pod/${pod} 中的${podSelectionLabel(selection, "Container")}：`,
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
  selection: PodSelectionContext,
): Promise<string | undefined> {
  const label = podSelectionLabel(selection, "Container");
  return promptListedChoice({
    question: `请选择${label}（序号或名称，q 取消）：`,
    match: (answer) => resolveContainerAnswer(choices, answer),
    invalidMessage: `请输入有效的序号，或${label}的名称。`,
  });
}
