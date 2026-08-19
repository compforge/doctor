import type { ModelType } from "@compforge/doctor-plugin";
import type { SelectedInferenceModel } from "../../model";
import { promptListedChoice } from "../../terminal/selection";
import type { ModelOutputFormat, ModelTestRequest } from "./model";

const MODEL_TYPES: readonly ModelType[] = ["llm", "embedding", "rerank", "audio"];
const MODEL_PERFORMANCE_CASES = 4;
const MODEL_IMAGE_TEST_DATA_URL = "data:image/png;base64,"
  + "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

export function parseModelOutputFormat(value: string | undefined): ModelOutputFormat {
  const format = value?.trim() || "default";
  if (format !== "default" && format !== "bundle" && format !== "json" && format !== "html") {
    throw new Error(`--format 只支持 bundle、json 或 html: '${format}'`);
  }
  return format;
}

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

export function buildModelTestRequest(model: SelectedInferenceModel): ModelTestRequest {
  const id = model.inference.model;
  if (model.type === "llm") {
    return {
      path: "/chat/completions",
      body: {
        model: id,
        messages: [{
          role: "user",
          content: model.inputModalities?.includes("image")
            ? [{
                type: "text",
                text: "What color is the square in this image? Reply with the color only.",
              }, {
                type: "image_url",
                image_url: { url: MODEL_IMAGE_TEST_DATA_URL },
              }]
            : "Reply with OK only.",
        }],
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
  if (model.type === "rerank") {
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
  throw new Error("doctor model 暂不支持 audio inference");
}
