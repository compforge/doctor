import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadCaseSet, validateCaseSet, type Case, type CaseSet } from "@compforge/spec-case/model";
import { CASE_RUNNER_CREATE_KIND, requireCaseRunnerCreateExtension, type PluginDefinition } from "@compforge/doctor-plugin";
import { isInteractive } from "../terminal/policy";
import { promptMultiSelect } from "../terminal/multi-select";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "../terminal/selection";
import { MODEL_IMAGE_TEST_DATA_URL } from "../collect/model/config";

export type DoctorCaseCommand = "http" | "model" | "perf";

export interface DoctorCaseSet {
  source: "builtin" | "plugin" | "local";
  service?: string;
  file?: string;
  caseSet: CaseSet;
}

const MODEL_CASE_SET: CaseSet = {
  caseset: "doctor_model",
  schema_version: 1,
  facets: {
    command: { values: ["model"] },
    model_type: { values: ["llm", "embedding", "rerank"] },
    mode: { values: ["connectivity", "performance"] },
  },
  cases: [
    {
      id: "llm_connectivity",
      desc: "LLM chat completions 连通性",
      input: { path: "/chat/completions", body: { messages: [{ role: "user", content: "Reply with OK only." }], stream: false } },
      facets: { command: "model", model_type: "llm", mode: "connectivity" },
    },
    {
      id: "llm_image",
      desc: "LLM 图片输入连通性",
      input: { path: "/chat/completions", body: { messages: [{ role: "user", content: [
        { type: "text", text: "What color is the square in this image? Reply with the color only." },
        { type: "image_url", image_url: { url: MODEL_IMAGE_TEST_DATA_URL } },
      ] }], stream: false } },
      facets: { command: "model", model_type: "llm", mode: "connectivity" },
    },
    {
      id: "embedding_connectivity",
      desc: "Embedding 连通性",
      input: { path: "/embeddings", body: { input: "doctor model connectivity test" } },
      facets: { command: "model", model_type: "embedding", mode: "connectivity" },
    },
    {
      id: "rerank_connectivity",
      desc: "Rerank 连通性",
      input: { path: "/rerank", body: { query: "doctor model connectivity test", documents: ["doctor model connectivity test", "unrelated document"], top_n: 1 } },
      facets: { command: "model", model_type: "rerank", mode: "connectivity" },
    },
    ...(["prefill_short", "prefill_medium", "prefill_long", "decode"] as const).map((id): Case => ({
      id,
      desc: `LLM 流式性能采样：${id}`,
      input: { kind: "performance", scenario: id.replace("_", "-") },
      facets: { command: "model", model_type: "llm", mode: "performance" },
    })),
  ],
};

/** The catalog describes requests; command-specific target and credentials never live in a Case. */
export function builtinModelCaseSet(): CaseSet {
  return MODEL_CASE_SET;
}

export function localDoctorCaseSet(file?: string, cwd = process.cwd()): DoctorCaseSet | undefined {
  const path = file ? resolve(cwd, file) : ["doctor-case.yaml", "doctor-case.yml"]
    .map((name) => resolve(cwd, name)).find(existsSync);
  if (!path) return undefined;
  const caseSet = loadCaseSet(path);
  validateCaseSet(caseSet);
  for (const item of caseSet.cases) {
    if (!["http", "model", "perf", "both"].includes(item.facets?.command ?? "")) {
      throw new Error(`${path}: Case '${item.id}' 需要 facets.command: http、model、perf 或 both`);
    }
  }
  return { source: "local", file: path, caseSet };
}

export function doctorCaseCatalog(plugin?: PluginDefinition, file?: string, cwd = process.cwd()): DoctorCaseSet[] {
  const catalog: DoctorCaseSet[] = [
    { source: "builtin", caseSet: MODEL_CASE_SET },
    { source: "builtin", caseSet: {
      caseset: "doctor_http", schema_version: 1,
      facets: { command: { values: ["http"] } },
      cases: [{ id: "http_get_root", desc: "GET / 连通性", input: { method: "GET", path: "/", expect: { status: 200 } }, facets: { command: "http" } }],
    } },
  ];
  for (const { service, extension } of plugin?.services.extensions(CASE_RUNNER_CREATE_KIND) ?? []) {
    for (const caseSet of requireCaseRunnerCreateExtension(extension).caseSets) {
      catalog.push({ source: "plugin", service: service.name, caseSet });
    }
  }
  const local = localDoctorCaseSet(file, cwd);
  if (local) catalog.push(local);
  return catalog;
}

export function caseMatchesCommand(item: Case, command: DoctorCaseCommand, legacyPlugin = false): boolean {
  const facet = item.facets?.command;
  return facet === command || facet === "both" || (legacyPlugin && !facet && command === "perf");
}

export interface DoctorCaseSelection {
  source: DoctorCaseSet;
  cases: Case[];
}

export async function selectDoctorCases(input: {
  catalog: readonly DoctorCaseSet[];
  command: DoctorCaseCommand;
  caseSetId?: string;
  caseIds?: string;
  service?: string;
  modelType?: string;
  defaultCaseSetId?: string;
  defaultCaseIds?: readonly string[];
}): Promise<DoctorCaseSelection | undefined> {
  const available = input.catalog.map((source) => ({
    source,
    cases: source.caseSet.cases.filter((item) => caseMatchesCommand(item, input.command, source.source === "plugin")
      && (!input.modelType || !item.facets?.model_type || item.facets.model_type === input.modelType)
      && (source.source !== "plugin" || !input.service || source.service === input.service)),
  })).filter((entry) => entry.cases.length > 0 && (input.command !== "perf" || entry.source.source !== "builtin"));
  if (!available.length) throw new Error(`没有可用于 doctor ${input.command} 的 Case`);
  const requestedSet = input.caseSetId ?? input.defaultCaseSetId;
  const matchingSets = requestedSet ? available.filter((entry) => entry.source.caseSet.caseset === requestedSet) : [];
  if (matchingSets.length > 1) throw new Error(`CaseSet '${requestedSet}' 同时来自多个来源；请避免重名`);
  let chosen: (typeof available)[number] | undefined = matchingSets[0];
  if (requestedSet && !chosen) throw new Error(`没有可用于 doctor ${input.command} 的 CaseSet '${requestedSet}'`);
  if (!chosen && available.length === 1) chosen = available[0];
  if (!chosen && isInteractive()) {
    printNumberedChoices(available, `[${input.command}] 可选 CaseSet：`, (entry) =>
      `${entry.source.caseSet.caseset} (${entry.source.source}${entry.source.service ? `/${entry.source.service}` : ""})`);
    chosen = await promptListedChoice({
      question: "请选择 CaseSet（编号，q 取消）：",
      match: (answer) => matchListedChoice(available, answer,
        (entry) => entry.source.caseSet.caseset, (entry) => entry),
      invalidMessage: "请输入列表中的 CaseSet 编号或名称。",
    });
    if (!chosen) return undefined;
  }
  if (!chosen) throw new Error(`有 ${available.length} 个可用 CaseSet；请用 --caseset 指定`);
  const requestedIds = input.caseIds?.split(",").map((id) => id.trim()).filter(Boolean);
  if (input.caseIds !== undefined && !requestedIds?.length) throw new Error("--cases 未解析出任何 Case ID");
  let ids = requestedIds;
  if (!ids && isInteractive()) {
    ids = await promptMultiSelect({
      choices: chosen.cases.map((item) => ({ name: item.id, description: item.desc })),
      defaults: [...(input.defaultCaseIds ?? [chosen.cases[0]!.id])].filter((id) => chosen!.cases.some((item) => item.id === id)),
      title: `[${input.command}] 选择一个或多个 Case`,
    });
    if (!ids) return undefined;
  }
  ids ??= [...(input.defaultCaseIds ?? [chosen.cases[0]!.id])].filter((id) => chosen.cases.some((item) => item.id === id));
  if (!ids.length) throw new Error("至少选择一个 Case");
  const byId = new Map(chosen.cases.map((item) => [item.id, item]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`CaseSet '${chosen.source.caseSet.caseset}' 不包含 Case：${unknown.join(", ")}`);
  return { source: chosen.source, cases: [...new Set(ids)].map((id) => byId.get(id)!) };
}
