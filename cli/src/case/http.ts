import { resolve } from "node:path";
import type { Case } from "@compforge/spec-case/model";
import { parseHttpScenario, type HttpScenarioOverrides } from "../collect/shared/http/config";
import type { HttpScenario } from "../collect/shared/http/model";
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
  const { path, entrypoints, ...request } = input;
  const normalized: Record<string, unknown> = {
    ...request,
    id: item.id,
    url: requestUrl(baseUrl, path, item.id),
  };
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
