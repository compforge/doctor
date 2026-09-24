import type { Case, CaseSet } from "@compforge/spec-case/model";
import { CASE_CATALOG_KIND, type CaseCatalogExtension } from "@compforge/doctor-plugin";
import { MODEL_IMAGE_TEST_DATA_URL } from "./config";

const MODEL_CASE_SET: CaseSet = {
  caseset: "doctor_model", schema_version: 1,
  facets: {
    command: { values: ["model"] },
    model_type: { values: ["llm", "embedding", "rerank"] },
    mode: { values: ["connectivity", "performance"] },
  },
  cases: [
    {
      id: "llm_connectivity", desc: "LLM chat completions 连通性",
      input: { path: "/chat/completions", body: { messages: [{ role: "user", content: "Reply with OK only." }], stream: false } },
      facets: { command: "model", model_type: "llm", mode: "connectivity" },
    },
    {
      id: "llm_image", desc: "LLM 图片输入连通性",
      input: { path: "/chat/completions", body: { messages: [{ role: "user", content: [
        { type: "text", text: "What color is the square in this image? Reply with the color only." },
        { type: "image_url", image_url: { url: MODEL_IMAGE_TEST_DATA_URL } },
      ] }], stream: false } },
      facets: { command: "model", model_type: "llm", mode: "connectivity" },
    },
    {
      id: "embedding_connectivity", desc: "Embedding 连通性",
      input: { path: "/embeddings", body: { input: "doctor model connectivity test" } },
      facets: { command: "model", model_type: "embedding", mode: "connectivity" },
    },
    {
      id: "rerank_connectivity", desc: "Rerank 连通性",
      input: { path: "/rerank", body: { query: "doctor model connectivity test", documents: ["doctor model connectivity test", "unrelated document"], top_n: 1 } },
      facets: { command: "model", model_type: "rerank", mode: "connectivity" },
    },
    ...(["prefill_short", "prefill_medium", "prefill_long", "decode"] as const).map((id): Case => ({
      id, desc: `LLM 流式性能采样：${id}`,
      input: { kind: "performance", scenario: id.replace("_", "-") },
      facets: { command: "model", model_type: "llm", mode: "performance" },
    })),
  ],
};

export const modelCaseCatalogExtension: CaseCatalogExtension = {
  id: "core.model", kind: CASE_CATALOG_KIND, load: () => [MODEL_CASE_SET],
};
