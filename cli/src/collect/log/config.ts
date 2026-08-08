import type { ServiceCatalog } from "@compforge/doctor-plugin";
import type { Executor } from "../../infra/k8s/executor";
import {
  listServiceChoices,
  rankRecentServiceChoices,
  recordRecentServiceTargets,
  type ServiceChoice,
} from "../../infra/k8s/service-selection";
import type { RecentSelections } from "../../infra/recent";
import {
  promptNamedChoices,
  type NamedChoiceSelectionInput,
} from "../../terminal/service-selection";

const ERROR_PATTERNS = [
  "\\bERROR\\b",
  "\\bTraceback\\b",
  "\\bException\\b",
  "\\berror:",
  "\\bfailed\\b",
  "RemoteProtocolError",
  "CancelledError",
  "incomplete chunked read",
];
const ERROR_PATTERN = new RegExp(ERROR_PATTERNS.map((part) => `(?:${part})`).join("|"));
const DEFAULT_LOG_SINCE = "6h";
const DEFAULT_LOG_WINDOW_MS = 6 * 60 * 60_000;
const UUID_V7_LEAD_MS = 60_000;
const COMPACT_UUID_V7 = /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/i;
const KUBECTL_PREFIX = /^\[pod\/[^\]]+\]\s+/;
const RFC3339_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\s+/;
const STACK_CONTINUATION = /^(?:Traceback \(most recent call last\):|During handling of the above exception|The above exception was the direct cause|Caused by:|Suppressed:|at\s+|\.{3} \d+ more|File\s+".+", line \d+|goroutine \d+ \[|created by |panic:|\S+\([^)]*\)$|[\w.]*(?:Error|Exception|Warning|Interrupt|Exit):)/;

function applicationLogText(line: string): string {
  return line.replace(KUBECTL_PREFIX, "").replace(RFC3339_PREFIX, "");
}

function isStackContinuation(line: string): boolean {
  const text = applicationLogText(line);
  return !text.trim() || /^\s+/.test(text) || STACK_CONTINUATION.test(text);
}

export interface TraceLineCollector {
  readonly lines: string[];
  /** 每项是一条逻辑日志事件；错误首行和其堆栈续行以换行连接。 */
  readonly events: string[];
  push(line: string): void;
}

/** 匹配异常首行后继续接收常见 Python/JavaScript/Java/Go 堆栈续行。 */
export function createTraceLineCollector(
  traceId: string,
  pattern?: RegExp,
): TraceLineCollector {
  const lines: string[] = [];
  const events: string[] = [];
  let collectingStack = false;
  return {
    lines,
    events,
    push: (line) => {
      if (collectingStack && isStackContinuation(line)) {
        lines.push(line);
        events[events.length - 1] += `\n${line}`;
        return;
      }
      const selected = line.includes(traceId) && (!pattern || pattern.test(line));
      if (selected) {
        lines.push(line);
        events.push(line);
        collectingStack = ERROR_PATTERN.test(line);
        return;
      }
      collectingStack = false;
    },
  };
}

export function resolveLogServices(raw: string, catalog: ServiceCatalog): string[] {
  const services: string[] = [];
  for (const item of raw.split(",")) {
    const service = item.trim();
    if (service && !services.includes(service)) services.push(service);
  }
  if (!services.length) throw new Error("--services 未解析出任何服务");
  const unsupported = services.filter((service) => !catalog.findWith(service, "log"));
  if (unsupported.length) {
    throw new Error(`Doctor 未注册以下 Service 的日志采集能力：${unsupported.join(", ")}`);
  }
  return services;
}

export interface LogServiceSelectionInput {
  raw?: string;
  namespace: string;
  catalog: ServiceCatalog;
  executor: Executor;
  kubeconfig?: string;
  context?: string;
  interactive?: boolean;
  recent?: RecentSelections;
  prompt?: (input: NamedChoiceSelectionInput<ServiceChoice>) => Promise<string[] | undefined>;
}

/** 显式 flag 直接采用；交互终端列出 Service 多选；非交互使用 doctor 默认名单。 */
export async function resolveLogServiceSelection(
  input: LogServiceSelectionInput,
): Promise<string[] | undefined> {
  if (input.raw !== undefined) return resolveLogServices(input.raw, input.catalog);
  const defaults = input.catalog.servicesWith("log")
    .filter((service) => service.capabilities.log.default)
    .map((service) => service.name);
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) return defaults;
  const listed = (await listServiceChoices(input.executor, input.namespace))
    .filter((choice) => input.catalog.findWith(choice.name, "log"));
  const choices = rankRecentServiceChoices(listed, input);
  if (!choices.length) {
    throw new Error(`namespace '${input.namespace}' 中没有具备日志采集能力的 Service`);
  }
  const selected = await (input.prompt ?? promptNamedChoices)({
    choices,
    defaults,
    candidateType: "Service",
    context: { purpose: "确定日志采集范围" },
  });
  if (selected) recordRecentServiceTargets(selected, input);
  return selected;
}

export function buildLogPattern(errorsOnly: boolean, pattern?: string): RegExp | undefined {
  const parts = errorsOnly ? [...ERROR_PATTERNS] : [];
  if (pattern) parts.push(pattern);
  return parts.length ? new RegExp(parts.map((part) => `(?:${part})`).join("|")) : undefined;
}

/** 显式窗口优先；UUIDv7 只缩小默认范围，不让旧 ID 扩大原有日志扫描。 */
export function resolveLogTimeWindow(input: {
  id: string;
  since?: string;
  sinceTime?: string;
  now?: Date;
}): { since?: string; sinceTime?: string } {
  if (input.sinceTime) return { sinceTime: input.sinceTime };
  if (input.since) return { since: input.since };

  const compact = input.id.replaceAll("-", "");
  if (!COMPACT_UUID_V7.test(compact)) return { since: DEFAULT_LOG_SINCE };
  const timestampMs = Number.parseInt(compact.slice(0, 12), 16);
  const nowMs = (input.now ?? new Date()).getTime();
  if (timestampMs < nowMs - DEFAULT_LOG_WINDOW_MS || timestampMs > nowMs + UUID_V7_LEAD_MS) {
    return { since: DEFAULT_LOG_SINCE };
  }
  return { sinceTime: new Date(timestampMs - UUID_V7_LEAD_MS).toISOString() };
}

export function filterTraceLines(stdout: string, traceId: string, pattern?: RegExp): string[] {
  const collector = createTraceLineCollector(traceId, pattern);
  const lines = stdout.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) collector.push(line);
  return collector.lines;
}
