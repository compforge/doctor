import type { PluginDefinition } from "@compforge/doctor-plugin";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandContext } from "../command";
import { terminalStderr, terminalStdout } from "../terminal/output";
import { promptMultiSelect } from "../terminal/multi-select";
import { runCollectData } from "./data";
import { runCollectLog } from "./log";
import { runCollectMetric } from "./metric";
import { failedReportHtml, writeTabbedReport } from "./output/tabbed-report";
import { runCollectTrace } from "./trace";

export const COLLECT_KINDS = ["data", "trace", "log", "metric"] as const;
export type CollectKind = typeof COLLECT_KINDS[number];

const COLLECT_LABELS: Record<CollectKind, string> = {
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
  kubeconfig?: string;
  context?: string;
  profile?: string;
  config?: string;
  output?: string;
}

export interface CollectDelegateResult {
  kind: CollectKind;
  code: number;
  outputPath: string;
  error?: string;
}

export type CollectDelegate = (kind: CollectKind, outputPath: string) => Promise<number>;

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

export function collectReportName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `doctor-collect-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function resolveCollectOutputPath(output: string | undefined, reportName: string): string {
  if (!output) return resolve(`${reportName}.html`);
  return resolve(output.toLowerCase().endsWith(".html") ? output : `${output}.html`);
}

/** 只执行所选具体命令，不在集合层增加另一套采集实现。 */
export async function runCollectDelegates(
  kinds: readonly CollectKind[],
  stagingDir: string,
  delegate: CollectDelegate,
): Promise<CollectDelegateResult[]> {
  const results: CollectDelegateResult[] = [];
  for (const kind of kinds) {
    const outputPath = join(stagingDir, `${kind}.html`);
    try {
      results.push({ kind, code: await delegate(kind, outputPath), outputPath });
    } catch (error) {
      results.push({
        kind,
        code: 1,
        outputPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function providerNames(plugin: PluginDefinition, capability: "data" | "log" | "metric"): string {
  return plugin.services.servicesWith(capability).map((service) => service.name).join(",");
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
  return async (kind, outputPath) => {
    switch (kind) {
      case "data":
        return runCollectData({
          ...common,
          bizIds: opts.bizIds,
          services: providerNames(plugin, "data"),
          format: "html",
          output: outputPath,
        }, plugin, undefined, undefined, commandContext);
      case "trace":
        return runCollectTrace({
          ...common,
          bizIds: opts.bizIds,
          pageSize: "1000",
          format: "html",
          output: outputPath,
        }, plugin, commandContext);
      case "log":
        return runCollectLog({
          ...common,
          bizIds: opts.bizIds,
          services: providerNames(plugin, "log"),
          since: opts.since,
          sinceTime: opts.sinceTime,
          format: "html",
          output: outputPath,
        }, plugin, commandContext);
      case "metric":
        return runCollectMetric({
          ...common,
          services: providerNames(plugin, "metric"),
          watch: opts.watch ?? "0",
          interval: opts.interval,
          prometheus: opts.prometheus,
          output: outputPath,
        }, plugin, commandContext);
    }
  };
}

/**
 * Collection command: it owns selection, delegation and combined delivery only.
 * Data, Trace, Log and Metric remain the sole owners of concrete collection work.
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
  const reportName = collectReportName();
  const outputPath = resolveCollectOutputPath(opts.output, reportName);
  if (existsSync(outputPath)) throw new Error(`--output 已存在，为避免覆盖请换一个路径：${outputPath}`);

  const stagingDir = mkdtempSync(join(tmpdir(), "doctor-collect-"));
  try {
    const results = await runCollectDelegates(
      opts.kinds,
      stagingDir,
      injectedDelegate ?? collectDelegate(opts, plugin, commandContext),
    );
    const tabs = results.map((result) => {
      const delivered = result.code === 0 && existsSync(result.outputPath);
      return {
        key: result.kind,
        label: COLLECT_LABELS[result.kind],
        status: delivered ? "delivered" as const : "failed" as const,
        html: existsSync(result.outputPath)
          ? readFileSync(result.outputPath, "utf8")
          : failedReportHtml(
            `${COLLECT_LABELS[result.kind]} 采集失败`,
            result.error ?? `collector exit ${result.code}，未形成 HTML 报告`,
          ),
      };
    });
    writeTabbedReport(outputPath, {
      title: "doctor collect",
      description: `biz-id: ${opts.bizIds.join(", ")} · 集合命令仅编排并汇总已有 collector`,
      ariaLabel: "采集结果",
      tabs,
    });
    const delivered = tabs.filter((tab) => tab.status === "delivered").length;
    terminalStdout.result(delivered > 0, `[collect] 集合报告: ${outputPath}（${delivered}/${tabs.length} 已交付）\n`);
    return delivered > 0 ? 0 : 1;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
