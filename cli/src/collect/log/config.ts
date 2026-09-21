import { isInteractive } from "../../terminal/policy";
import { logTimestampNanos } from "@compforge/harness-toolbox/kubernetes/log-timestamp";
import type { ServiceCatalog } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import {
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
  /** 最近 keepTail 行里未被筛选命中的原始行；用于被杀/崩溃容器的尾部取证，未配置 keepTail 时恒为空。 */
  drainTail(): string[];
}

/** Empty traceIds selects the time-window logs; matching errors retain their stack continuation. */
export function createTraceLineCollector(
  traceIds: string | readonly string[],
  pattern?: RegExp,
  onTraceMatch?: (traceId: string) => void,
  options?: { keepTail?: number },
): TraceLineCollector {
  const ids = typeof traceIds === "string" ? [traceIds] : traceIds;
  const lines: string[] = [];
  const events: string[] = [];
  let collectingStack = false;
  const notified = new Set<string>();
  const keepTail = options?.keepTail ?? 0;
  // 崩溃/被杀容器的关键证据在中断点而非"匹配错误的行"；尾部环形缓冲保留原样最后 N 行，
  // 已命中筛选的行由 events 携带，drain 时排除避免重复。
  const tail: { line: string; selected: boolean }[] = [];
  const pushTail = (line: string, selected: boolean) => {
    if (!keepTail) return;
    tail.push({ line, selected });
    if (tail.length > keepTail) tail.shift();
  };
  return {
    lines,
    events,
    push: (line) => {
      const matchesTrace = ids.some((traceId) => line.includes(traceId));
      if (matchesTrace && onTraceMatch) {
        for (const traceId of ids) {
          if (!notified.has(traceId) && line.includes(traceId)) {
            notified.add(traceId);
            onTraceMatch(traceId);
          }
        }
      }
      if (collectingStack && isStackContinuation(line)) {
        lines.push(line);
        events[events.length - 1] += `\n${line}`;
        pushTail(line, true);
        return;
      }
      const selected = (ids.length === 0 || matchesTrace) && (!pattern || pattern.test(line));
      if (selected) {
        lines.push(line);
        events.push(line);
        collectingStack = ERROR_PATTERN.test(line);
        pushTail(line, true);
        return;
      }
      collectingStack = false;
      pushTail(line, false);
    },
    drainTail: () => tail.filter((item) => !item.selected).map((item) => item.line),
  };
}

export function resolveLogServices(raw: string, catalog: ServiceCatalog): string[] {
  const services: string[] = [];
  for (const item of raw.split(",")) {
    const service = item.trim();
    if (service && !services.includes(service)) services.push(service);
  }
  if (!services.length) throw new Error("--services 未解析出任何服务");
  const unsupported = services.filter((service) => !catalog.find(service)?.logs);
  if (unsupported.length) {
    throw new Error(`Doctor 未注册以下 Service 的日志采集能力：${unsupported.join(", ")}`);
  }
  return catalog.resolveNames(services);
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
  const defaults = input.catalog.services.filter(service => service.logs !== undefined)
    .filter((service) => service.logs!.default)
    .map((service) => service.name);
  const interactive = isInteractive(input.interactive);
  if (!interactive) return defaults;
  const listed = input.catalog.services.filter(service => service.logs !== undefined).map(service => ({ name: service.name }));
  const choices = rankRecentServiceChoices(listed, input);
  if (!choices.length) {
    throw new Error(`namespace '${input.namespace}' 的 Plugin Catalog 中没有具备日志采集能力的 Service`);
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

export function buildLogPattern(errorsOnly: boolean, pattern?: string, serviceErrorPatterns: readonly string[] = []): RegExp | undefined {
  // Service 声明的 errorPatterns 并入 errors-only：业务错误常走 WARNING/INFO 级（如 error_type=104502），
  // 通用正则抓不到。非 errors-only 模式不按内容过滤，servicePatterns 无意义。
  const parts = errorsOnly ? [...ERROR_PATTERNS, ...serviceErrorPatterns] : [];
  if (pattern) parts.push(pattern);
  return parts.length ? new RegExp(parts.map((part) => `(?:${part})`).join("|")) : undefined;
}

/** 汇总所选 Service 在 Plugin 声明里的 errors-only 补充签名；未声明的 Service 不影响。 */
export function serviceLogErrorPatterns(
  catalog: ServiceCatalog,
  services: readonly string[],
): string[] {
  return services.flatMap((name) => [...(catalog.find(name)?.logs?.errorPatterns ?? [])]);
}

/** 显式窗口优先；UUIDv7 只缩小默认范围，不让旧 ID 扩大原有日志扫描。 */
export function resolveLogTimeWindow(input: {
  id?: string;
  since?: string;
  sinceTime?: string;
  now?: Date;
}): { since?: string; sinceTime?: string } {
  if (input.sinceTime) return { sinceTime: input.sinceTime };
  if (input.since) return { since: input.since };

  const compact = input.id?.replaceAll("-", "") ?? "";
  if (!COMPACT_UUID_V7.test(compact)) return { since: DEFAULT_LOG_SINCE };
  const timestampMs = Number.parseInt(compact.slice(0, 12), 16);
  const nowMs = (input.now ?? new Date()).getTime();
  if (timestampMs < nowMs - DEFAULT_LOG_WINDOW_MS || timestampMs > nowMs + UUID_V7_LEAD_MS) {
    return { since: DEFAULT_LOG_SINCE };
  }
  return { sinceTime: new Date(timestampMs - UUID_V7_LEAD_MS).toISOString() };
}

/** Reject ambiguous/invalid upper bounds before any remote access. */
export function validateLogTimeWindow(input: { sinceTime?: string; untilTime?: string }): void {
  if (input.untilTime === undefined) return;
  const end = logTimestampNanos(input.untilTime);
  if (end === undefined) throw new Error("--until-time 必须是 RFC3339 时间戳");
  if (input.sinceTime !== undefined) {
    const start = logTimestampNanos(input.sinceTime);
    if (start === undefined) throw new Error("--since-time 必须是 RFC3339 时间戳");
    if (start > end) throw new Error("--until-time 不能早于 --since-time");
  }
}

export function filterTraceLines(stdout: string, traceIds: string | readonly string[], pattern?: RegExp): string[] {
  const collector = createTraceLineCollector(traceIds, pattern);
  const lines = stdout.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) collector.push(line);
  return collector.lines;
}
