import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import { inspectContainerMemory, type MemoryResizeTarget } from "../../infra/target/memory-resize";
import { isInteractive } from "../../terminal/policy";
import { formatProgressBytes } from "../../terminal/progress";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "../../terminal/selection";
import { writeOutput } from "../../terminal/output";
import type { ResizeCliOpts } from "./model";
import { parseResizeMemory } from "./plan";

const MIB = 1024n * 1024n;
const RESOURCES = [
  { name: "mem", label: "Mem（内存）", supported: true },
  { name: "cpu", label: "CPU（暂不支持）", supported: false },
] as const;

export function matchResizeResource(answer: string): "mem" | undefined {
  return matchListedChoice(RESOURCES, answer, choice => choice.name, choice => choice.supported ? "mem" as const : undefined);
}

export interface MemoryGrowthChoice {
  percent: 50 | 100;
  bytes: string;
}

/**
 * @spec Percentage choices use the observed container cgroup limit, never Kubernetes spec or RSS.
 * @why A previous temporary resize can leave the declared and running limits different.
 */
export function memoryGrowthChoices(limitBytes: string): MemoryGrowthChoice[] {
  if (!/^[1-9]\d*$/.test(limitBytes)) throw new Error("当前 Container 内存上限无效");
  const limit = BigInt(limitBytes);
  const choices = ([50, 100] as const).map(percent => {
    // Keep candidates compatible with --memory's MiB granularity and kernel page rounding.
    const numerator = limit * BigInt(100 + percent);
    const bytes = ((numerator + 100n * MIB - 1n) / (100n * MIB)) * MIB;
    return { percent, bytes: String(bytes) };
  });
  if (choices.some(choice => BigInt(choice.bytes) > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("当前 Container 未设置可用于计算候选的有限内存上限；请显式指定 --memory");
  }
  return choices;
}

export function matchMemoryGrowth(choices: readonly MemoryGrowthChoice[], answer: string): string | undefined {
  const value = answer.trim().replace(/^\+/, "").replace(/%$/, "");
  const percentage = choices.find(choice => String(choice.percent) === value);
  return percentage?.bytes ?? matchListedChoice(choices, value, choice => String(choice.percent), choice => choice.bytes);
}

export async function selectResizeMemory(
  executor: Executor, target: MemoryResizeTarget, opts: ResizeCliOpts,
): Promise<{ requestedBytes: string; expectedLimitBytes: string } | undefined> {
  if (!opts.memory) {
    if (!isInteractive(opts.interactive)) throw new Error("非交互调用请指定 --memory <size>");
    printNumberedChoices(RESOURCES, "[resize] 请选择要调整的资源：", choice => choice.label);
    const resource = await promptListedChoice({
      question: "资源类型（序号或 mem，q 取消）：",
      match: matchResizeResource,
      invalidMessage: "当前仅支持 Mem（内存）；请选择 1 或 mem，CPU 暂不支持",
    });
    if (!resource) return undefined;
  }

  const memory = await inspectContainerMemory(executor, target);
  writeOutput(`[resize] pod/${target.pod} container/${target.container} 当前内存上限：`
    + `${formatProgressBytes(Number(memory.limitBytes))}；用量：${formatProgressBytes(Number(memory.currentBytes))}\n`);
  if (opts.memory) return { requestedBytes: parseResizeMemory(opts.memory), expectedLimitBytes: memory.limitBytes };

  const choices = memoryGrowthChoices(memory.limitBytes);
  printNumberedChoices(choices, "[resize] 扩容候选（目标值向上取整至 MiB）：", choice =>
    `增加 ${choice.percent}%：${formatProgressBytes(Number(memory.limitBytes))} → ${formatProgressBytes(Number(choice.bytes))}`);
  const requestedBytes = await promptListedChoice({
    question: "选择增加额度（序号、50% 或 100%，q 取消）：",
    match: answer => matchMemoryGrowth(choices, answer),
    invalidMessage: "请选择 1（增加 50%）或 2（增加 100%）",
  });
  return requestedBytes ? { requestedBytes, expectedLimitBytes: memory.limitBytes } : undefined;
}
