import type {
  Model,
  TenantDirectory,
  TenantSummary,
} from "@compforge/doctor-plugin";

import {
  printNumberedChoices,
  promptSearchableChoice,
  type SearchableChoiceResolution,
} from "../terminal/selection";
import { promptTenantChoice } from "../terminal/tenant-selection";
import { terminalStdout, type TerminalTone } from "../terminal/output";
import {
  recentSelectionsForInteractive,
  type RecentSelections,
} from "../infra/recent";
import type { SelectedInferenceModel } from "./types";
import { isMultimodalModel } from "./types";
import {
  defineCommandDecision,
  type CommandContext,
} from "../command";

const tenantSelectionDecision = defineCommandDecision<TenantSummary | undefined>("tenant-selection");

export async function resolveTenant(input: {
  tenantId?: string;
  tenantName?: string;
  profileName?: string;
  directory: TenantDirectory;
  commandContext?: CommandContext;
  promptTitle?: string;
  interactive?: boolean;
  recent?: RecentSelections;
  prompt?: (tenants: readonly TenantSummary[]) => Promise<TenantSummary | undefined>;
}): Promise<TenantSummary | undefined> {
  const resolve = async (): Promise<TenantSummary | undefined> => {
    const tenantId = input.tenantId?.trim();
    const tenantName = input.tenantName?.trim();
    if (tenantId && tenantName) throw new Error("--tenant-id 与 --tenant-name 不能同时使用");
    if (tenantId) return { id: tenantId, name: tenantId, displayName: tenantId };
    if (tenantName) return input.directory.getByName(tenantName);

    const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) {
      throw new Error("非交互环境必须通过 --tenant-id 或 --tenant-name 显式指定租户");
    }
    const tenants = await input.directory.listActive();
    if (!tenants.length) throw new Error("租户目录未返回当前启用租户");
    const recent = recentSelectionsForInteractive(input.interactive, input.recent);
    const recentChoices = input.profileName && recent
      ? recent.recentChoices("tenant", input.profileName, tenants, (tenant) => tenant.id)
      : [];
    const selected = await (input.prompt ?? ((choices) => promptTenantChoice({
      choices,
      title: input.promptTitle ?? "[tenant] 当前启用租户：",
      recentChoices,
    })))(tenants);
    if (selected && input.profileName) {
      recent?.recordChoice("tenant", input.profileName, selected.id);
    }
    return selected;
  };
  return input.commandContext
    ? await input.commandContext.decide(
        tenantSelectionDecision,
        [input.profileName ?? input.commandContext.profile.name],
        resolve,
      )
    : await resolve();
}

export const resolveModelTenant = resolveTenant;

function modelSearchKeys(model: Model): string[] {
  return [
    model.id,
    model.name,
    model.type,
    model.provider,
    model.vendor,
  ]
    .filter((value): value is string => !!value)
    .map((value) => value.toLowerCase());
}

export function resolveModelPromptChoice(
  models: readonly Model[],
  answer: string,
  numberedChoices: readonly Model[],
): SearchableChoiceResolution<Model, Model> {
  const normalized = answer.trim().toLowerCase();
  if (/^\d+$/.test(normalized)) {
    const selected = numberedChoices[Number(normalized) - 1];
    return selected
      ? { kind: "selected", value: selected }
      : { kind: "invalid-number" };
  }
  const exact = models.filter((model) => modelSearchKeys(model).includes(normalized));
  if (exact.length === 1) return { kind: "selected", value: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", matches: exact };
  const matches = models.filter((model) => modelSearchKeys(model).some((key) => key.includes(normalized)));
  if (matches.length === 1) return { kind: "selected", value: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "not-found" };
}

export function modelChoiceTone(model: Model): TerminalTone {
  if (isMultimodalModel(model)) return "magenta";
  if (model.type === "embedding") return "blue";
  if (model.type === "rerank") return "warning";
  return "info";
}

function renderModelChoice(model: Model): string {
  const vendor = model.vendor ? `/${model.vendor}` : "";
  return terminalStdout.style(
    `${model.name}（${model.type}，${model.provider}${vendor}，${model.id}）`,
    modelChoiceTone(model),
  );
}

async function promptModel(models: readonly Model[]): Promise<Model | undefined> {
  const printChoices = (items: readonly Model[], title: string) =>
    printNumberedChoices(items, title, renderModelChoice);
  printChoices(models, "[model] 当前租户可用模型：");
  return promptSearchableChoice({
    choices: models,
    choicesAreListed: true,
    question: () => "输入模型关键词或列表序号（q 取消）：",
    resolve: (answer, numberedChoices) => resolveModelPromptChoice(models, answer, numberedChoices),
    printChoices,
    ambiguousTitle: (answer) => `[model] 匹配 '${answer}' 的模型：`,
    notFoundMessage: (answer) => `未找到匹配 '${answer}' 的模型。`,
    invalidNumberMessage: "输入的序号不在当前候选中。",
    emptyMessage: "请输入模型关键词或列表序号。",
  });
}

export async function selectModel(input: {
  models: readonly Model[];
  query?: string;
  profileName?: string;
  tenantId?: string;
  interactive?: boolean;
  recent?: RecentSelections;
  prompt?: (models: readonly Model[]) => Promise<Model | undefined>;
}): Promise<Model | undefined> {
  if (!input.models.length) throw new Error("模型目录未返回可用模型");
  const query = input.query?.trim();
  if (query) {
    const result = resolveModelPromptChoice(input.models, query, []);
    if (result.kind === "selected") return result.value;
    if (result.kind === "ambiguous") {
      throw new Error(
        `--model '${query}' 匹配到多个模型：${result.matches.map((model) => `${model.name}(${model.id})`).join("、")}`,
      );
    }
    throw new Error(`模型目录中找不到 --model '${query}'`);
  }
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) throw new Error("非交互环境必须通过 --model <id|name> 显式指定模型");
  const recent = recentSelectionsForInteractive(input.interactive, input.recent);
  const recentScope = input.profileName && input.tenantId
    ? JSON.stringify([input.profileName, input.tenantId])
    : undefined;
  const recentModels = recent && recentScope
    ? recent.recentChoices("model", recentScope, input.models, (model) => model.id)
    : [];
  const recentIds = new Set(recentModels.map((model) => model.id));
  const rankedModels = [
    ...recentModels,
    ...input.models.filter((model) => !recentIds.has(model.id)),
  ];
  const selected = await (input.prompt ?? promptModel)(rankedModels);
  if (selected && recentScope) {
    recent?.recordChoice("model", recentScope, selected.id);
  }
  return selected;
}

export function requireInferenceModel(model: Model): SelectedInferenceModel {
  const baseUrl = model.inference?.baseUrl;
  const inferenceModel = model.inference?.model;
  if (!baseUrl || !inferenceModel) {
    throw new Error(`模型 '${model.name}' 缺少 inference baseUrl 或 model`);
  }
  return {
    ...model,
    type: model.type,
    inference: { baseUrl, model: inferenceModel },
  };
}
