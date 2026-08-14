import { terminalStderr, terminalStdout } from "../../terminal/output";
import { matchListedChoice, promptListedChoice } from "../../terminal/selection";
import type { CgroupMemoryFacts } from "../fact/cgroup-memory";
import type { HeapDumpBackendKind } from "../../infra/dump";

export type MemoryCaptureBackend = HeapDumpBackendKind;

export interface BackendChoice {
  backend: MemoryCaptureBackend;
  description: string;
}

const MIB = 1024 ** 2;

function byteCount(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / MIB).toFixed(1)} MiB`;
}

export function cgroupMemoryHint(cgroup?: CgroupMemoryFacts): string {
  const current = byteCount(cgroup?.currentBytes);
  const limit = byteCount(cgroup?.limitBytes);
  if (current === undefined || limit === undefined || limit <= 0 || cgroup?.version === undefined) {
    return "目标 cgroup 余量未知";
  }
  const remaining = Math.max(0, limit - current);
  return `目标 cgroup v${cgroup.version}：${formatBytes(current)} / ${formatBytes(limit)}`
    + `（${(current / limit * 100).toFixed(1)}%，剩余 ${formatBytes(remaining)}）`;
}

export function parseMemoryBackend(value: string | undefined): MemoryCaptureBackend | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "pydump" || normalized === "pyheap") return normalized;
  throw new Error(`--backend 仅支持 pydump 或 pyheap: '${value}'`);
}

export function memoryBackendChoices(cgroup?: CgroupMemoryFacts): readonly BackendChoice[] {
  const hint = cgroupMemoryHint(cgroup);
  return [
    {
      backend: "pydump",
      description: `主要把图遍历内存放在 Collector；${hint}`,
    },
    {
      backend: "pyheap",
      description: `在目标 Python 进程内遍历对象，可能显著增加目标 cgroup 内存；${hint}`,
    },
  ];
}

export async function resolveMemoryBackend(input: {
  requested?: string;
  cgroupMemory?: CgroupMemoryFacts;
  interactive?: boolean;
  prompt?: (choices: readonly BackendChoice[]) => Promise<MemoryCaptureBackend | undefined>;
}): Promise<MemoryCaptureBackend | undefined> {
  const requested = parseMemoryBackend(input.requested);
  if (requested) return requested;
  const interactive = input.interactive ?? (!!process.stdin.isTTY && !!process.stdout.isTTY);
  if (!interactive) {
    terminalStderr.error("[collect] 非交互运行 doctor mem 时必须显式指定 --backend pydump 或 --backend pyheap\n");
    return undefined;
  }
  const choices = memoryBackendChoices(input.cgroupMemory);
  terminalStdout.info("[collect] 请选择 heap 采集后端（cgroup 余量仅作提示，不自动决策）：\n");
  choices.forEach((choice, index) => {
    terminalStdout.write(`  ${index + 1}) ${choice.backend}  ${choice.description}\n`);
  });
  return input.prompt
    ? input.prompt(choices)
    : promptListedChoice({
        question: "请选择 backend（序号或名称，q 取消）：",
        match: (answer) => matchListedChoice(
          choices,
          answer,
          (choice) => choice.backend,
          (choice) => choice.backend,
        ),
        invalidMessage: "输入无效，请输入 pydump、pyheap 或对应序号。",
      });
}
