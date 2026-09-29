import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { LlmConfig } from "./types";

/** Register only the host-selected model and transport; Pi must not discover other credentials. */
export function createModelAccess(llm: LlmConfig) {
  const contextWindow = llm.contextWindow ?? 128_000;
  const maxTokens = llm.maxTokens ?? Math.min(32_000, Math.floor(contextWindow / 4));
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0
    || !Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens >= contextWindow) {
    throw new Error("llm.context_window 和 llm.max_tokens 必须为正整数，且 max_tokens 小于 context_window");
  }
  const deepseek = llm.provider === "deepseek";
  const model: Model<"openai-completions"> = {
    id: llm.model, name: llm.model, api: "openai-completions", provider: llm.provider,
    baseUrl: llm.endpoint ?? (deepseek ? "https://api.deepseek.com" : "https://api.openai.com/v1"),
    reasoning: !!llm.thinking || deepseek, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens,
    ...(deepseek ? { compat: { supportsStore: false, supportsDeveloperRole: false,
      requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" as const } } : {}),
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: llm.provider, models: [model],
    auth: { apiKey: { name: "Doctor model access", resolve: async () => ({ auth: { apiKey: llm.apiKey } }) } },
    api: {
      stream: (selected, context, options) => stream(selected as typeof model, context,
        { ...options, fetch: llm.fetch as typeof globalThis.fetch | undefined }),
      streamSimple: (selected, context, options) => streamSimple(selected as typeof model, context,
        { ...options, fetch: llm.fetch as typeof globalThis.fetch | undefined }),
    },
  }));
  return { models, model };
}
