import type { DebugCapability } from "../../infra/target/debug";
import {
  defineCommandDecision,
  type CommandContext,
} from "../../command";
import {
  matchListedChoice,
  printNumberedChoices,
  promptListedChoice,
} from "../../terminal/selection";

export const DEFAULT_DEBUG_CAPABILITIES: readonly DebugCapability[] = [
  "SYS_PTRACE",
  "NET_RAW",
];

interface DebugCapabilityChoice {
  name: string;
  description: string;
  capabilities: readonly DebugCapability[];
}

const DEBUG_CAPABILITY_CHOICES: readonly DebugCapabilityChoice[] = [
  {
    name: "SYS_PTRACE",
    description: "GDB、内存和 CPU 进程诊断",
    capabilities: ["SYS_PTRACE"],
  },
  {
    name: "NET_RAW",
    description: "网络抓包诊断",
    capabilities: ["NET_RAW"],
  },
  {
    name: "both",
    description: "同时准备进程与网络诊断能力",
    capabilities: DEFAULT_DEBUG_CAPABILITIES,
  },
];

const debugCapabilities = defineCommandDecision<readonly DebugCapability[] | undefined>(
  "debug.capabilities",
);

async function promptDebugCapabilities(): Promise<readonly DebugCapability[] | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return DEFAULT_DEBUG_CAPABILITIES;

  printNumberedChoices(
    DEBUG_CAPABILITY_CHOICES,
    "[debug] 请选择 debug container 要申请的 capability：",
    (choice) => `${choice.name === "both" ? "SYS_PTRACE + NET_RAW" : choice.name}`
      + `（${choice.description}）`,
  );
  return promptListedChoice({
    question: "请选择 capability（序号或名称，默认 both，q 取消）：",
    match: (answer) => matchListedChoice(
      DEBUG_CAPABILITY_CHOICES,
      answer,
      (choice) => choice.name,
      (choice) => choice.capabilities,
    ),
    invalidMessage: "未找到 capability，可选：SYS_PTRACE、NET_RAW、both",
    emptyValue: DEFAULT_DEBUG_CAPABILITIES,
  });
}

export function resolveDebugCapabilities(
  commandContext: CommandContext,
): Promise<readonly DebugCapability[] | undefined> {
  return commandContext.decide(debugCapabilities, [], promptDebugCapabilities);
}
