import {
  defineCommandDecision,
  type CommandContext,
  type CommandScope,
} from "../command";

/** 业务调用方提供选择意图；具体选择器补充候选类型并统一生成终端文案。 */
export interface SelectionContext {
  purpose: string;
  candidateRole?: string;
  effect?: string;
}

const userSelection = defineCommandDecision<string | undefined>("terminal.user-selection");

/** purpose 定义选择目的，候选类型与现场作用域避免不同目标之间误复用。 */
export function selectionPurposeScope(
  context: SelectionContext,
  candidateType: string,
  scope: readonly string[],
): CommandScope {
  return [context.purpose, candidateType, ...scope];
}

export function resolveUserSelection(
  commandContext: CommandContext,
  context: SelectionContext,
  candidateType: string,
  scope: readonly string[],
  resolver: () => Promise<string | undefined>,
): Promise<string | undefined> {
  return commandContext.decide(
    userSelection,
    selectionPurposeScope(context, candidateType, scope),
    resolver,
  );
}

export function selectionCandidateLabel(
  context: SelectionContext,
  candidateType: string,
): string {
  return context.candidateRole
    ? `${context.candidateRole} ${candidateType}`
    : candidateType;
}

export function selectionInstruction(
  context: SelectionContext,
  candidateType: string,
  action: "请选择" | "请输入",
): string {
  const separator = context.candidateRole ? "" : " ";
  return `${action}${separator}${selectionCandidateLabel(context, candidateType)}`;
}

export function selectionTitle(
  context: SelectionContext,
  candidateType: string,
): string {
  return `[collect] ${context.purpose}，${selectionInstruction(context, candidateType, "请选择")}：`;
}
