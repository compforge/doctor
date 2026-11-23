import { previewCaseInput } from "./params";
import { dirname, resolve } from "node:path";
import type { Case } from "@compforge/spec-case/model";
import { validateHttpCase } from "@compforge/spec-case/http";
import { parseHttpScenario, type HttpScenarioOverrides } from "../collect/shared/http/config";
import type { HttpScenario } from "../collect/shared/http/model";
import { renderHttpRequestAsCurl } from "../collect/http/render";
import { caseMatchesCommand } from "./catalog";
import { caseRef, type CaseChoice } from "./choices";
import type { DoctorCaseSelection } from "./catalog";

function requestUrl(baseUrl: string, path: unknown, id: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`Case '${id}' 的 input.path 必须是以 / 开头的相对路径`);
  }
  const target = new URL(baseUrl);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new Error("--base-url 必须是无凭据的 http(s) URL");
  }
  return new URL(path, target).toString();
}

function requestFromCase(item: Case, baseUrl: string): Record<string, unknown> {
  const input = item.input;
  for (const key of ["url", "base_url", "host", "port", "ip"]) {
    if (key in input) throw new Error(`Case '${item.id}' 不能声明目标 ${key}；请使用 --base-url`);
  }
  const { path, entrypoints, protocol, ...request } = input;
  const normalized: Record<string, unknown> = {
    ...request,
    id: item.id,
    url: requestUrl(baseUrl, path, item.id),
  };
  if (protocol !== undefined) {
    validateHttpCase(item);
    const unsupported = Object.keys(item.judge?.e2e ?? {}).filter(key => key !== "http");
    if (unsupported.length) throw new Error(`Case '${item.id}': doctor case cannot evaluate judge.e2e.${unsupported.join(", ")}`);
    const expect = item.judge?.e2e?.http;
    if (expect) normalized.expect = { status: expect.status, content_type: expect.contentType };
  }
  if (entrypoints !== undefined) {
    if (!Array.isArray(entrypoints)) throw new Error(`Case '${item.id}' 的 entrypoints 必须是数组`);
    normalized.entrypoints = entrypoints.map((entrypoint) => {
      if (!entrypoint || typeof entrypoint !== "object" || Array.isArray(entrypoint)) {
        throw new Error(`Case '${item.id}' 的 entrypoint 必须是对象`);
      }
      const { path: entryPath, ...rest } = entrypoint as Record<string, unknown>;
      if ("url" in rest) throw new Error(`Case '${item.id}' 的 entrypoint 不能声明 url`);
      return { ...rest, url: requestUrl(baseUrl, entryPath ?? path, item.id) };
    });
  }
  return normalized;
}

/** Adapt selected canonical Cases to the existing HTTP probe without persisting request bodies in command input. */
export function httpScenarioFromDoctorCases(
  selection: DoctorCaseSelection,
  baseUrl: string,
  overrides: HttpScenarioOverrides = {},
): HttpScenario {
  const sourcePath = selection.source.file ?? resolve("doctor-cases.yaml");
  return parseHttpScenario({
    schema: "doctor-http/v1",
    name: selection.source.caseSet.caseset,
    requests: selection.cases.map((item) => requestFromCase(item, baseUrl)),
  }, sourcePath, overrides);
}

export function prepareHttpCases(choices: CaseChoice[], baseUrl: string, overrides: HttpScenarioOverrides = {}) {
  if (!choices.length) throw new Error("请选择 HTTP Case");
  const first = choices[0]!.source;
  const multiple = choices.some(c => c.source !== first);
  const name = multiple ? first.service : first.caseSet.caseset;
  const requests = choices.flatMap(choice => {
    const {source, item} = choice;
    const scenario = httpScenarioFromDoctorCases({source, cases:[item]}, baseUrl, overrides);
    if (!multiple) return scenario.requests;
    const id = caseRef(choice).replaceAll("/", ":");
    return scenario.requests.map(group => ({...group, id, entrypoints:group.entrypoints.map(plan => ({...plan, requestId:id}))}));
  });
  return {
    scenario:{schema:"doctor-http/v1" as const, name, requests}, source:first.file ?? name,
    origin:{type:"doctor_case", service:first.service, caseset:multiple ? undefined : first.caseSet.caseset,
      cases:requests.map(r => r.id), refs:choices.map(caseRef)},
  };
}

export function caseCurlPreview(choice: CaseChoice, baseUrl?: string, overrides: HttpScenarioOverrides = {}): string[] {
  const {source} = choice;
  const item = previewCaseInput(choice.item);
  const template = source.previewHttp?.(item);
  if (template) {
    const headers = {...template.headers};
    const body = template.body === undefined ? undefined : JSON.stringify(template.body);
    if (body !== undefined && !Object.keys(headers).some(k => k.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    return [renderHttpRequestAsCurl({
      url:requestUrl(baseUrl ?? template.baseUrl, template.path, item.id), method:template.method ?? "GET",
      headers, body:body === undefined ? undefined : new TextEncoder().encode(body), timeoutMs:template.timeoutMs,
    }, {stream:template.stream})];
  }
  if (!caseMatchesCommand({id:item.id, input:item.input}, "http")) return [];
  // Leave file bodies as @path in the preview. Reading them belongs to execution.
  const {body_file, ...input} = item.input;
  const file = typeof body_file === "string" ? resolve(dirname(source.file ?? resolve("doctor-cases.yaml")), body_file) : undefined;
  // A request preview needs the wire input only. Protocol-specific verdicts belong to execution.
  const preview = {id:item.id, input:file ? {...input, body:""} : item.input};
  const scenario = httpScenarioFromDoctorCases({source, cases:[preview]}, baseUrl ?? "http://preview.invalid", overrides);
  return scenario.requests.flatMap(group => group.entrypoints.map(plan =>
    renderHttpRequestAsCurl(plan, {useBaseUrl:!baseUrl, bodyFile:file})));
}
