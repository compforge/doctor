import {
  printNumberedChoices,
  promptSearchableChoice,
  type SearchableChoiceResolution,
} from "./selection";

export interface TenantPromptChoice {
  id?: string;
  name: string;
  displayName: string;
}

const TENANT_PREVIEW_LIMIT = 10;

function tenantSearchKeys(choice: TenantPromptChoice): string[] {
  return [choice.name, choice.displayName, choice.id]
    .filter((value): value is string => !!value)
    .map((value) => value.toLowerCase());
}

export function resolveTenantPromptChoice<Choice extends TenantPromptChoice>(
  choices: readonly Choice[],
  answer: string,
  numberedChoices: readonly Choice[],
): SearchableChoiceResolution<Choice, Choice> {
  const normalized = answer.trim().toLowerCase();
  if (/^\d+$/.test(normalized)) {
    const choice = numberedChoices[Number(normalized) - 1];
    return choice === undefined
      ? { kind: "invalid-number" }
      : { kind: "selected", value: choice };
  }
  const exact = choices.filter((choice) => tenantSearchKeys(choice).includes(normalized));
  if (exact.length === 1) return { kind: "selected", value: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", matches: exact };
  const matches = choices.filter((choice) => tenantSearchKeys(choice).some((key) => key.includes(normalized)));
  if (matches.length === 1) return { kind: "selected", value: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "not-found" };
}

/** 租户较少时直接展示供序号选择；特殊项（如“仅部署配置”）不计入租户数量。 */
export function shouldPreviewTenantChoices(
  choices: readonly TenantPromptChoice[],
  numberedChoices: readonly TenantPromptChoice[] = [],
): boolean {
  const tenantCount = choices.filter((choice) => choice.id).length;
  return numberedChoices.length === 0
    && tenantCount > 0
    && tenantCount <= TENANT_PREVIEW_LIMIT;
}

export async function promptTenantChoice<Choice extends TenantPromptChoice>(input: {
  choices: readonly Choice[];
  title: string;
}): Promise<Choice | undefined> {
  const printChoices = (items: readonly Choice[], title: string): void => printNumberedChoices(
    items,
    title,
    (choice) => choice.id
      ? `${choice.name}（${choice.displayName}，${choice.id}）`
      : `${choice.name}（${choice.displayName}）`,
  );
  let numberedChoices: readonly Choice[] = [];
  if (shouldPreviewTenantChoices(input.choices)) {
    printChoices(input.choices, input.title);
    numberedChoices = input.choices;
  }
  const specialChoices = input.choices.filter((choice) => !choice.id).map((choice) => choice.name);
  const specialHint = specialChoices.length ? `，也可输入 ${specialChoices.join(" / ")}` : "";
  return promptSearchableChoice({
    choices: input.choices,
    numberedChoices,
    question: (listed) => listed
      ? "请选择租户（序号、名称、展示名或 ID，q 取消）："
      : `请输入租户关键词（名称、展示名或 ID${specialHint}，q 取消）：`,
    resolve: (answer, numberedChoices) =>
      resolveTenantPromptChoice(input.choices, answer, numberedChoices),
    printChoices,
    ambiguousTitle: (answer) => `匹配 '${answer}' 的租户：`,
    notFoundMessage: (answer) => `未找到匹配 '${answer}' 的租户。`,
    invalidNumberMessage: "输入的序号不在当前候选中。",
    emptyMessage: "请输入租户关键词或列表序号。",
  });
}
