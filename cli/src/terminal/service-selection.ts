import { promptMultiSelect } from "./multi-select";

export interface NamedChoice {
  name: string;
}

/** 可搜索的安装器式多选，具体按键和渲染统一由 terminal 组件负责。 */
export async function promptNamedChoices<Choice extends NamedChoice>(
  choices: readonly Choice[],
  defaults: readonly string[],
  title = defaults.length ? "[collect] 可选资源（默认项已选中）：" : "[collect] 可选资源：",
): Promise<string[] | undefined> {
  return promptMultiSelect({
    choices,
    defaults,
    title,
  });
}
