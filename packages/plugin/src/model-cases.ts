import type { Case, CaseSet } from "@compforge/spec-case/model";
import type { HttpCase } from "@compforge/spec-case/http";
import type { Model } from "./definition";
import type { CaseProduceResult } from "./case-producer";

export const MODEL_IMAGE_TEST_DATA_URL = "data:image/png;base64,"
  + "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

export const MODEL_CASE_SET: CaseSet = {
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
      id: "llm_adjacent_assistants", desc: "检查两条 assistant 消息相邻时模型是否接受请求",
      input: { path: "/chat/completions", body: { messages: [
        { role: "system", content: "Reply with OK only." },
        { role: "user", content: "Start a short conversation." },
        { role: "assistant", content: "First assistant message." },
        { role: "assistant", content: "Second assistant message." },
        { role: "user", content: "Reply with OK only." },
      ], stream: false } },
      facets: { command: "model", model_type: "llm", mode: "connectivity" },
    },
    {
      id: "llm_adjacent_users", desc: "检查两条 user 消息相邻时模型是否接受请求",
      input: { path: "/chat/completions", body: { messages: [
        { role: "system", content: "Reply with OK only." },
        { role: "user", content: "Start a short conversation." },
        { role: "user", content: "Reply with OK only." },
      ], stream: false } },
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

/** Functional stimuli only; model throughput sampling remains owned by doctor model. */
export function modelConnectivityCases(model: Pick<Model, "type" | "inputModalities">): Case[] {
  return MODEL_CASE_SET.cases.filter(item => item.facets?.mode === "connectivity"
    && item.facets.model_type === model.type
    && (item.id !== "llm_image" || model.inputModalities?.includes("image")));
}

/** Offline HTTP stimuli for Service.cases.load; runtime binding reuses these exact definitions. */
export const MODEL_CONNECTIVITY_CASE_SET: CaseSet = {
  caseset: "model_connectivity", schema_version: 1,
  facets: { model_type: { values: ["llm", "embedding", "rerank"] } },
  cases: MODEL_CASE_SET.cases.filter(item => item.facets?.mode === "connectivity").map((item): HttpCase => ({
    id: item.id, desc: item.desc,
    facets: { model_type: item.facets!.model_type! },
    input: { protocol: "http", method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item.input.body) },
    judge: { e2e: { http: { status: [200], contentType: "application/json" }, model: { type: item.facets!.model_type } } },
  })),
};

/** @spec Bind shared model stimuli to one runtime target without putting routing or credentials into Case identity. */
export function modelHttpCases(model: Model): CaseProduceResult["cases"] {
  const templates = modelConnectivityCases(model);
  if (!templates.length) throw new Error(`No Health Cases for model type '${model.type}'`);
  const { baseUrl, model: inferenceModel } = model.inference ?? {};
  if (!baseUrl || !inferenceModel) throw new Error(`Model '${model.id}' requires inference baseUrl and model`);
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error(`Model '${model.id}' requires a credential-free HTTP(S) inference base URL`);
  }
  return templates.map(item => ({
    subject: { id: model.id, label: model.name },
    case: MODEL_CONNECTIVITY_CASE_SET.cases.find(value => value.id === item.id)! as HttpCase,
    // Joining an absolute /chat/completions with new URL would discard a configured /v1 prefix.
    targets: [{ id: "inference", url: `${base.href.replace(/\/+$/, "")}${item.input.path}`,
      body: JSON.stringify({ ...(item.input.body as Record<string, unknown>), model: inferenceModel }) }],
  }));
}
