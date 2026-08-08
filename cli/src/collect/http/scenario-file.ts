import { writeFileSync } from "node:fs";
import { findSelectableFiles, resolveFileSelection } from "../../terminal/file-selection";
import { promptNamedChoices } from "../../terminal/service-selection";
import { loadHttpScenario } from "../shared/http/config";
import type { HttpScenario } from "../shared/http/model";

export const HTTP_SCENARIO_EXAMPLE = `schema: doctor-http/v1
name: example-api

requests:
  - id: create-item
    method: POST
    url: http://api.example.test:8080/v1/items
    headers:
      X-Tenant-ID: example-tenant
      Content-Type: application/json
    json:
      message: hello
    entrypoints:
      - id: edge-gateway
        headers:
          Host: edge-gateway.example.test
      - id: proxy
        url: http://proxy.example.test:8080/v1/items
        headers:
          Host: proxy.example.test
      - id: api
        url: http://api.example.test:8080/v1/items
        headers:
          Host: api.example.test
    expect:
      status: 200

  - id: health
    method: GET
    url: http://api.example.test:8080/health
    expect:
      status: 200
`;

export function writeHttpScenarioExample(path = "example.yaml"): string {
  try {
    writeFileSync(path, HTTP_SCENARIO_EXAMPLE, { encoding: "utf-8", flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EEXIST") throw new Error(`示例文件已存在，未覆盖: ${path}`);
    throw new Error(`写入 HTTP 示例文件 '${path}' 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  return path;
}

export function findHttpScenarioFiles(directory = "."): string[] {
  return findSelectableFiles(
    directory,
    (name, path) => {
      if (!/\.ya?ml$/i.test(name)) return false;
      try {
        loadHttpScenario(path);
        return true;
      } catch {
        return false;
      }
    },
  );
}

export interface ResolveHttpScenarioFileInput {
  file?: string;
  directory?: string;
  interactive?: boolean;
  prompt?: (files: readonly string[]) => Promise<string | undefined>;
}

export async function resolveHttpScenarioFile(
  input: ResolveHttpScenarioFileInput,
): Promise<string | undefined> {
  return resolveFileSelection({
    ...input,
    findCandidates: findHttpScenarioFiles,
    listTitle: "[http] 当前目录可用的 HTTP 场景：",
    question: "请选择 YAML（序号或文件名，q 取消）：",
    invalidMessage: "输入无效，请输入列表中的序号或文件名。",
    cancelledMessage: "已取消 HTTP 场景选择。",
    missingFileMessage: "缺少 --file；非交互环境请显式指定 YAML，或使用 --example 生成示例",
    noCandidatesMessage: "当前目录没有符合 doctor-http/v1 schema 的 YAML；可先运行 doctor http --example",
    singleCandidateMessage: (file) => `[http] HTTP 场景：${file}（当前目录唯一候选，自动选择）`,
  });
}

export function filterHttpScenarioRequests(scenario: HttpScenario, requestIds: readonly string[]): HttpScenario {
  const selected = new Set(requestIds.map((id) => id.trim()).filter(Boolean));
  if (!selected.size) throw new Error("--request 至少需要一个 request id");

  const available = new Set(scenario.requests.map((request) => request.id));
  const unknown = [...selected].filter((id) => !available.has(id));
  if (unknown.length) {
    throw new Error(`未找到 request: ${unknown.join(", ")}；可选值: ${[...available].join(", ")}`);
  }
  return {
    ...scenario,
    requests: scenario.requests.filter((request) => selected.has(request.id)),
  };
}

export interface ResolveHttpScenarioRequestsInput {
  request?: string;
  interactive?: boolean;
  prompt?: (
    choices: readonly { name: string }[],
    defaults: readonly string[],
    title: string,
  ) => Promise<string[] | undefined>;
}

export async function resolveHttpScenarioRequests(
  scenario: HttpScenario,
  input: ResolveHttpScenarioRequestsInput,
): Promise<HttpScenario | undefined> {
  if (input.request?.trim()) {
    return filterHttpScenarioRequests(scenario, input.request.split(","));
  }

  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive || scenario.requests.length === 1) return scenario;

  const choices = scenario.requests.map((request) => ({ name: request.id }));
  const selected = await (input.prompt ?? promptNamedChoices)(
    choices,
    [],
    "[http] 选择本次要执行的 Request：",
  );
  return selected ? filterHttpScenarioRequests(scenario, selected) : undefined;
}
