import type { Case, Param } from "@compforge/spec-case/model";
import type { CommandInvocation } from "@compforge/doctor-plugin";
import { isInteractive } from "../terminal/policy";
import { promptListedChoice } from "../terminal/selection";

export type CaseDataset = readonly Readonly<Record<string, string>>[];

function paramValue(value: unknown, type: string, label: string, fromText: boolean): unknown {
  if (type === "string" && typeof value === "string") return value;
  if (fromText && typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw new Error(`${label} 应为 ${type}`); }
  }
  switch (type) {
    case "boolean": if (typeof value === "boolean") return value; break;
    case "integer": if (Number.isSafeInteger(value)) return value; break;
    case "number": if (Number.isFinite(value)) return value; break;
    case "object": if (value !== null && typeof value === "object" && !Array.isArray(value)) return value; break;
    case "array": if (Array.isArray(value)) return value; break;
    case "null": if (value === null) return null; break;
  }
  throw new Error(`${label} 应为 ${type}`);
}

function sourceValue(source: string | undefined, command: CommandInvocation) {
  if (!source) return undefined;
  if (source === "command.tenant_id") return command.tenantId;
  if (source === "command.user_id") return command.userId;
  throw new Error(`未知的 Case 参数来源: ${source}`);
}

function renderInput(value: unknown, values: ReadonlyMap<string, unknown>, id: string): unknown {
  if (Array.isArray(value)) return value.map(entry => renderInput(entry, values, id));
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value);
  if (entries.length === 1 && entries[0]![0] === "$param") {
    const name = entries[0]![1];
    if (typeof name !== "string" || !values.has(name)) throw new Error(`Case ${id}: 未声明参数 ${name}`);
    return structuredClone(values.get(name));
  }
  return Object.fromEntries(entries.map(([key, entry]) => [key, renderInput(entry, values, id)]));
}

function rendered(item: Case, values: ReadonlyMap<string, unknown>): Case {
  const input = renderInput(item.input, values, item.id);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`Case ${item.id}: input 必须渲染为对象`);
  return { ...item, input: input as Case["input"] };
}

/** Offline previews display defaults and named placeholders without opening a profile or prompting. */
export function previewCaseInput(item: Case): Case {
  if (!item.params) return item;
  return rendered(item, new Map(Object.entries(item.params).map(([name, param]) =>
    [name, Object.hasOwn(param, "default") ? param.default : `<${name.toUpperCase()}>`])));
}

async function askValue(label: string, param: Param): Promise<string | undefined> {
  if (!isInteractive()) throw new Error(`${label} 缺少值，请提供 Case 参数值或配置默认来源`);
  return promptListedChoice({ question: `请输入 ${label} (${param.type}，q 取消)：`,
    match: answer => {
      try { paramValue(answer, param.type, label, true); return answer; } catch { return undefined; }
    }, invalidMessage: `请输入 ${param.type} 类型的值。` });
}

/** @spec Validate every dataset record before load starts. One dispatch samples one coherent row. */
export async function prepareCaseInput(item: Case, rows: CaseDataset, command: CommandInvocation,
  ask = askValue): Promise<(() => Case) | undefined> {
  if (!item.params || !Object.keys(item.params).length) return () => item;
  const constants = new Map<string, unknown>();
  const columns = new Map<string, unknown[]>();
  for (const [name, param] of Object.entries(item.params)) {
    const label = `Case ${item.id} params.${name}`;
    if (!["string", "integer", "number", "boolean", "object", "array", "null"].includes(param.type)) {
      throw new Error(`${label}: 不支持类型 ${param.type}`);
    }
    if (rows.length && Object.hasOwn(rows[0]!, name)) {
      columns.set(name, rows.map((row, index) => paramValue(row[name], param.type, `${label} (CSV 记录 ${index + 1})`, true)));
      continue;
    }
    let value: unknown = sourceValue(param.source, command);
    if (value === undefined) value = param.default;
    if (value === undefined) {
      const answer = await ask(label, param);
      if (answer === undefined) return undefined;
      value = paramValue(answer, param.type, label, true);
    }
    constants.set(name, paramValue(value, param.type, label, false));
  }
  const at = (index: number) => {
    const values = new Map(constants);
    for (const [name, column] of columns) values.set(name, column[index]);
    return rendered(item, values);
  };
  at(0); // Verify references before dispatch, including cases rarely selected by the mix.
  return () => at(columns.size ? Math.floor(Math.random() * rows.length) : 0);
}
