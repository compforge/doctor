import type {
  Model,
  ModelType,
} from "@compforge/doctor-plugin";
import type {
  TenantDirectory,
  TenantSummary,
} from "@compforge/doctor-plugin";
import {
  printNumberedChoices,
  promptListedChoice,
  promptSearchableChoice,
  type SearchableChoiceResolution,
} from "../../terminal/selection";
import { promptTenantChoice } from "../../terminal/tenant-selection";
import type {
  ModelTestRequest,
  SelectedInferenceModel,
} from "./model";

const MODEL_TYPES: readonly ModelType[] = ["llm", "embedding", "rerank", "audio"];
const MODEL_PERFORMANCE_CASES = 4;

export function parseModelType(value: string | undefined): ModelType | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!MODEL_TYPES.includes(normalized as ModelType)) {
    throw new Error(`--type 只支持 ${MODEL_TYPES.join("、")}: '${value}'`);
  }
  return normalized as ModelType;
}

export function parseModelTimeout(value: string | undefined): number {
  const seconds = Number(value ?? "60");
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) {
    throw new Error("--timeout 必须是 1..600 秒");
  }
  return Math.round(seconds * 1000);
}

export function parseModelPort(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${flag} 必须是 1..65535 的整数`);
  }
  return port;
}

export function parseModelPerformanceRepeat(value: string | undefined): number {
  const repeat = Number(value ?? "3");
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) {
    throw new Error("--repeat 必须是 1..20 的整数");
  }
  return repeat;
}

export function parseModelMaxOutputTokens(value: string | undefined): number {
  const tokens = Number(value ?? "256");
  if (!Number.isInteger(tokens) || tokens < 32 || tokens > 4096) {
    throw new Error("--max-output-tokens 必须是 32..4096 的整数");
  }
  return tokens;
}

async function promptModelPerformance(repeat: number): Promise<boolean> {
  const measuredRequests = repeat * MODEL_PERFORMANCE_CASES;
  return (await promptListedChoice({
    question: "执行标准模型性能采样"
      + `（短/中/长输入 + 持续生成，${MODEL_PERFORMANCE_CASES} 次 warmup`
      + ` + ${measuredRequests} 次计量请求）？[y/N] `,
    match: (answer) => {
      if (/^(y|yes)$/i.test(answer)) return true;
      if (/^(n|no)$/i.test(answer)) return false;
      return undefined;
    },
    invalidMessage: "请输入 y/yes 或 n/no。",
    emptyValue: false,
  })) ?? false;
}

export async function resolveModelPerformanceEnabled(input: {
  enabled?: boolean;
  repeat: number;
  interactive?: boolean;
  prompt?: (repeat: number) => Promise<boolean>;
}): Promise<boolean> {
  if (input.enabled !== undefined) return input.enabled;
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) return false;
  return (input.prompt ?? promptModelPerformance)(input.repeat);
}

export async function resolveModelTenant(input: {
  tenantId?: string;
  tenantName?: string;
  directory: TenantDirectory;
  interactive?: boolean;
  prompt?: (tenants: readonly TenantSummary[]) => Promise<TenantSummary | undefined>;
}): Promise<TenantSummary | undefined> {
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
  return (input.prompt ?? ((choices) => promptTenantChoice({
    choices,
    title: "[model] 当前启用租户：",
  })))(tenants);
}

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

function renderModelChoice(model: Model): string {
  const vendor = model.vendor ? `/${model.vendor}` : "";
  return `${model.name}（${model.type}，${model.provider}${vendor}，${model.id}）`;
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
  interactive?: boolean;
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
  return (input.prompt ?? promptModel)(input.models);
}

export function requireInferenceModel(model: Model): SelectedInferenceModel {
  if (model.type === "audio") {
    throw new Error("doctor model 当前支持 llm、embedding、rerank，暂不支持 audio inference");
  }
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

export function buildModelTestRequest(model: SelectedInferenceModel): ModelTestRequest {
  const id = model.inference.model;
  if (model.type === "llm") {
    return {
      path: "/chat/completions",
      body: {
        model: id,
        messages: [{ role: "user", content: "Reply with OK only." }],
        stream: false,
      },
    };
  }
  if (model.type === "embedding") {
    return {
      path: "/embeddings",
      body: { model: id, input: "doctor model connectivity test" },
    };
  }
  return {
    path: "/rerank",
    body: {
      model: id,
      query: "doctor model connectivity test",
      documents: ["doctor model connectivity test", "unrelated document"],
      top_n: 1,
    },
  };
}
