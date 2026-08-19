import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import { terminalStderr } from "../terminal/output";
import { promptMultiSelect } from "../terminal/multi-select";
import { runCollectData } from "./data";
import { runCollectInspect } from "./inspect";
import { runCollectLog } from "./log";
import { runCollectMetric } from "./metric";
import { runCollectTrace } from "./trace";

export const COLLECT_KINDS = ["inspect", "data", "trace", "log", "metric"] as const;
export type CollectKind = typeof COLLECT_KINDS[number];
export type CollectOutputFormat = "default" | "bundle" | "html";

const COLLECT_LABELS: Record<CollectKind, string> = {
  inspect: "Inspect · Service 运行态与配置",
  data: "Data · 业务关联数据",
  trace: "Trace · 调用链与耗时",
  log: "Log · 关联日志",
  metric: "Metric · Service 指标",
};

export interface CollectCliOpts {
  bizIds: string[];
  kinds: CollectKind[];
  namespace?: string;
  since?: string;
  sinceTime?: string;
  watch?: string;
  interval?: string;
  prometheus?: string;
  deploymentConfig?: boolean;
  dependencies?: boolean;
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  output?: string;
  format?: string;
}

export interface CollectDelegateResult {
  kind: CollectKind;
  code: number;
  error?: string;
}

export type CollectDelegate = (kind: CollectKind) => Promise<number>;

export function parseCollectKinds(raw: string | undefined): CollectKind[] {
  if (!raw?.trim()) return [...COLLECT_KINDS];
  const values = [...new Set(raw.split(/[,|\s]+/).map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const unknown = values.filter((value) => !COLLECT_KINDS.includes(value as CollectKind));
  if (unknown.length) {
    throw new Error(`--include 仅支持 ${COLLECT_KINDS.join("、")}：${unknown.join("、")}`);
  }
  if (!values.length) throw new Error("--include 需要至少一个采集命令");
  return values as CollectKind[];
}

export async function resolveCollectKinds(
  raw: string | undefined,
  interactive = !!(process.stdin.isTTY && process.stdout.isTTY),
): Promise<CollectKind[] | undefined> {
  if (raw !== undefined || !interactive) return parseCollectKinds(raw);
  const selected = await promptMultiSelect({
    choices: COLLECT_KINDS.map((name) => ({ name })),
    defaults: COLLECT_KINDS,
    title: "选择 doctor collect 要编排的采集命令",
    renderChoice: (choice) => COLLECT_LABELS[choice.name as CollectKind],
  });
  return selected as CollectKind[] | undefined;
}

export function parseCollectOutputFormat(raw: string | undefined): CollectOutputFormat {
  const format = raw?.trim() || "default";
  if (format !== "default" && format !== "bundle" && format !== "html") {
    throw new Error(`--format 只支持 bundle 或 html: '${format}'`);
  }
  return format;
}

/** 只执行所选具体命令，不在集合层增加另一套采集实现。 */
export async function runCollectDelegates(
  kinds: readonly CollectKind[],
  delegate: CollectDelegate,
): Promise<CollectDelegateResult[]> {
  const results: CollectDelegateResult[] = [];
  for (const kind of kinds) {
    try {
      results.push({ kind, code: await delegate(kind) });
    } catch (error) {
      results.push({
        kind,
        code: 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function providerNames(plugin: PluginDefinition, capability: "data" | "log" | "metric"): string {
  return plugin.services.servicesWith(capability).map((service) => service.name).join(",");
}

/** biz-id 不能推导 Service 范围；组合执行时显式采用 Plugin 声明的完整业务 Service 边界。 */
function inspectServiceNames(plugin: PluginDefinition): string {
  return plugin.services.services.map((service) => service.name).join(",");
}

function collectDelegate(
  opts: CollectCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
): CollectDelegate {
  const common = {
    namespace: opts.namespace,
    kubeconfig: opts.kubeconfig,
    context: opts.context,
    profile: commandContext.profile.name,
    config: opts.config,
  };
  return async (kind) => {
    const format = parseCollectOutputFormat(opts.format);
    let code: number;
    switch (kind) {
      case "inspect":
        code = await runCollectInspect({
          ...common,
          services: inspectServiceNames(plugin),
          deploymentConfig: opts.deploymentConfig,
          dependencies: opts.dependencies,
          format,
          output: undefined,
        }, plugin, commandContext);
        break;
      case "data":
        code = await runCollectData({
          ...common,
          bizIds: opts.bizIds,
          services: providerNames(plugin, "data"),
          format,
          output: undefined,
        }, plugin, commandContext);
        break;
      case "trace":
        code = await runCollectTrace({
          ...common,
          bizIds: opts.bizIds,
          pageSize: "1000",
          format,
          output: undefined,
        }, plugin, commandContext);
        break;
      case "log":
        code = await runCollectLog({
          ...common,
          bizIds: opts.bizIds,
          services: providerNames(plugin, "log"),
          since: opts.since,
          sinceTime: opts.sinceTime,
          format,
          output: undefined,
        }, plugin, commandContext);
        break;
      case "metric":
        code = await runCollectMetric({
          ...common,
          services: providerNames(plugin, "metric"),
          watch: opts.watch ?? "0",
          interval: opts.interval,
          prometheus: opts.prometheus,
          format,
          output: undefined,
        }, plugin, commandContext);
        break;
    }
    return code;
  };
}

/**
 * Collection command owns selection and delegation only; global finalize owns delivery.
 * Inspect, Data, Trace, Log and Metric remain the sole owners of concrete collection work.
 */
export async function runCollect(
  opts: CollectCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
  injectedDelegate?: CollectDelegate,
): Promise<number> {
  if (!opts.bizIds.length) {
    terminalStderr.error("doctor collect 需要至少一个 biz-id\n");
    return 2;
  }
  parseCollectOutputFormat(opts.format);
  const results = await runCollectDelegates(
    opts.kinds,
    injectedDelegate ?? collectDelegate(opts, plugin, commandContext),
  );
  return results.some((result) => result.code === 0) ? 0 : 1;
}
