import { promptMultiSelect } from "./multi-select";

export interface NamedChoice {
  name: string;
}

/** 可搜索的安装器式多选，具体按键和渲染统一由 terminal 组件负责。 */
export async function promptNamedChoices<Choice extends NamedChoice>(
  choices: readonly Choice[],
  defaults: readonly string[],
  title: string,
): Promise<string[] | undefined> {
  return promptMultiSelect({
    choices,
    defaults,
    title,
  });
}
