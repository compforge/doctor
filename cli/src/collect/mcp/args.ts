import type { McpArgumentDefinition } from "@compforge/doctor-plugin";

export type ParsedArgInput =
  | { kind: "value"; value: unknown }
  | { kind: "omitted" };

function parseJson(raw: string, arg: McpArgumentDefinition): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${arg.name} 需要合法 ${arg.type} JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateEnum(arg: McpArgumentDefinition, value: unknown): void {
  if (!arg.enum?.length) return;
  if (!arg.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`${arg.name} 只能取：${arg.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }
}

export function parseMcpArgInput(arg: McpArgumentDefinition, raw: string): ParsedArgInput {
  const trimmed = raw.trim();
  if (!trimmed) {
    if (arg.required && arg.default === undefined) throw new Error(`${arg.name} 是必填参数`);
    return { kind: "omitted" };
  }

  let value: unknown;
  switch (arg.type.toLowerCase()) {
    case "string":
      value = raw;
      break;
    case "integer":
      if (!/^[+-]?\d+$/.test(trimmed)) throw new Error(`${arg.name} 需要 integer`);
      value = Number(trimmed);
      if (!Number.isSafeInteger(value)) throw new Error(`${arg.name} 超出 JavaScript 安全整数范围`);
      break;
    case "number":
      value = Number(trimmed);
      if (!Number.isFinite(value)) throw new Error(`${arg.name} 需要有限 number`);
      break;
    case "boolean": {
      const normalized = trimmed.toLowerCase();
      if (["true", "1", "yes", "y"].includes(normalized)) value = true;
      else if (["false", "0", "no", "n"].includes(normalized)) value = false;
      else throw new Error(`${arg.name} 需要 boolean（true/false、yes/no 或 1/0）`);
      break;
    }
    case "array":
      value = parseJson(trimmed, arg);
      if (!Array.isArray(value)) throw new Error(`${arg.name} 需要 JSON array`);
      break;
    case "object":
      value = parseJson(trimmed, arg);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${arg.name} 需要 JSON object`);
      break;
    default:
      value = parseJson(trimmed, arg);
  }
  validateEnum(arg, value);
  return { kind: "value", value };
}

export function describeMcpArg(arg: McpArgumentDefinition): string {
  const traits = [arg.type, arg.position, arg.required ? "required" : "optional"];
  if (arg.default !== undefined) traits.push(`default=${JSON.stringify(arg.default)}`);
  if (arg.enum?.length) traits.push(`enum=${arg.enum.map((item) => JSON.stringify(item)).join("|")}`);
  return `${arg.name} (${traits.join(", ")})${arg.description ? ` — ${arg.description}` : ""}`;
}
