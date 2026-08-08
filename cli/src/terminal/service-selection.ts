import { promptMultiSelect } from "./multi-select";
import { terminalStdout } from "./output";
import { selectionTitle, type SelectionContext } from "./selection-context";

export interface NamedChoice {
  name: string;
}

export interface NamedChoiceSelectionInput<Choice extends NamedChoice> {
  choices: readonly Choice[];
  defaults: readonly string[];
  candidateType: string;
  context: SelectionContext;
}

/** 可搜索的安装器式多选，具体按键和渲染统一由 terminal 组件负责。 */
export async function promptNamedChoices<Choice extends NamedChoice>(
  input: NamedChoiceSelectionInput<Choice>,
): Promise<string[] | undefined> {
  if (input.context.effect) terminalStdout.write(`[collect] ${input.context.effect}\n`);
  return promptMultiSelect({
    choices: input.choices,
    defaults: input.defaults,
    title: selectionTitle(input.context, input.candidateType),
  });
}
