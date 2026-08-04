import { terminalStdout } from "../../terminal/output";
import {
  matchListedChoice,
  printNumberedChoices,
  promptListedChoice,
} from "../../terminal/selection";

export type HttpExecutionLocation = "local" | "pod";

interface HttpExecutionLocationChoice {
  location: HttpExecutionLocation;
  description: string;
}

export const HTTP_EXECUTION_LOCATION_CHOICES: readonly HttpExecutionLocationChoice[] = [
  { location: "local", description: "从 Doctor 本机发起请求" },
  { location: "pod", description: "通过 kubectl exec 从指定 Pod/Container 发起请求" },
];

export function parseHttpExecutionLocation(value: string): HttpExecutionLocation {
  const normalized = value.trim().toLowerCase();
  if (normalized === "local" || normalized === "pod") return normalized;
  throw new Error(`--location 只支持 local 或 pod: '${value}'`);
}

export function matchHttpExecutionLocation(answer: string): HttpExecutionLocation | undefined {
  return matchListedChoice(
    HTTP_EXECUTION_LOCATION_CHOICES,
    answer,
    (choice) => choice.location,
    (choice) => choice.location,
  );
}

export function printHttpExecutionLocationChoices(): void {
  printNumberedChoices(
    HTTP_EXECUTION_LOCATION_CHOICES,
    "[http] 请选择请求执行位置：",
    (choice) => `${choice.location}  ${choice.description}`,
  );
}

export async function promptHttpExecutionLocation(): Promise<HttpExecutionLocation | undefined> {
  return promptListedChoice({
    question: "请选择执行位置（序号或名称，q 取消）：",
    match: matchHttpExecutionLocation,
    invalidMessage: "请输入有效的执行位置序号、local 或 pod。",
  });
}

export async function resolveHttpExecutionLocation(input: {
  location?: string;
  pod?: string;
  container?: string;
  interactive?: boolean;
  prompt?: typeof promptHttpExecutionLocation;
}): Promise<HttpExecutionLocation | undefined> {
  const explicit = input.location?.trim()
    ? parseHttpExecutionLocation(input.location)
    : undefined;
  const hasPodTarget = !!(input.pod?.trim() || input.container?.trim());
  if (explicit === "local" && hasPodTarget) {
    throw new Error("--location local 不能与 --pod/--container 同时使用");
  }
  if (explicit) return explicit;
  if (hasPodTarget) return "pod";

  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) return "local";
  printHttpExecutionLocationChoices();
  return (input.prompt ?? promptHttpExecutionLocation)();
}

