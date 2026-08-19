import type { PluginDefinition } from "@compforge/doctor-plugin";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandContext } from "../command";
import { terminalStderr, terminalStdout } from "../terminal/output";
import { promptMultiSelect } from "../terminal/multi-select";
import { runCollectData } from "./data";
import { runCollectInspect } from "./inspect";
import { runCollectLog } from "./log";
import { runCollectMetric } from "./metric";
import { packReportBundle, resolveArchivePath, resolveDefaultReportPaths } from "./output/archive";
import { failedReportHtml, writeTabbedReport } from "./output/tabbed-report";
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

export function safeCollectBizId(bizId: string): string {
  const normalized = bizId
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(normalized || "biz").slice(0, 64).join("");
}

export function collectReportName(bizIds: readonly string[], now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const target = bizIds.length === 1 ? safeCollectBizId(bizIds[0]!) : "batch";
  return `doctor-collect-${target}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function resolveCollectOutputPath(output: string | undefined, reportName: string): string {
  if (!output) return resolve(`${reportName}.html`);
  return resolve(output.toLowerCase().endsWith(".html") ? output : `${output}.html`);
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

/** biz-id 不能推导 Service 范围；组合执行时显式采用 Plugin 声明的完整业务 Service 边界。 */
function inspectServiceNames(plugin: PluginDefinition): string {
  return plugin.services.services.map((service) => service.name).join(",");
}

function collectDelegate(
  opts: CollectCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
  fullBundle: boolean,
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
      case "inspect":
        return runCollectInspect({
          ...common,
          services: inspectServiceNames(plugin),
          deploymentConfig: opts.deploymentConfig,
          dependencies: opts.dependencies,
          format: fullBundle ? undefined : "html",
          output: outputPath,
        }, plugin, commandContext);
      case "data":
        return runCollectData({
          ...common,
          bizIds: opts.bizIds,
          services: providerNames(plugin, "data"),
          format: fullBundle ? undefined : "html",
          output: outputPath,
        }, plugin, commandContext);
      case "trace":
        return runCollectTrace({
          ...common,
          bizIds: opts.bizIds,
          pageSize: "1000",
          format: fullBundle ? undefined : "html",
          output: outputPath,
        }, plugin, commandContext);
      case "log":
        return runCollectLog({
          ...common,
          bizIds: opts.bizIds,
          services: providerNames(plugin, "log"),
          since: opts.since,
          sinceTime: opts.sinceTime,
          format: fullBundle ? undefined : "html",
          output: outputPath,
        }, plugin, commandContext);
      case "metric":
        return runCollectMetric({
          ...common,
          services: providerNames(plugin, "metric"),
          watch: opts.watch ?? "0",
          interval: opts.interval,
          prometheus: opts.prometheus,
          format: fullBundle ? undefined : "html",
          output: outputPath,
        }, plugin, commandContext);
    }
  };
}

/**
 * Collection command: it owns selection, delegation and combined delivery only.
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
  const reportName = collectReportName(opts.bizIds);
  const format = parseCollectOutputFormat(opts.format);
  const paths = format === "default"
    ? resolveDefaultReportPaths(opts.output, reportName)
    : {
        html: format === "html" ? resolveCollectOutputPath(opts.output, reportName) : "",
        bundle: format === "bundle" ? resolveArchivePath(opts.output, reportName) : "",
      };
  for (const outputPath of [paths.html, paths.bundle].filter(Boolean)) {
    if (existsSync(outputPath)) throw new Error(`--output 已存在，为避免覆盖请换一个路径：${outputPath}`);
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), "doctor-collect-"));
  const stagingDir = join(stagingRoot, reportName);
  mkdirSync(stagingDir, { recursive: true });
  let cleanupStaging = true;
  try {
    const results = await runCollectDelegates(
      opts.kinds,
      stagingDir,
      injectedDelegate ?? collectDelegate(opts, plugin, commandContext, format !== "html"),
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
    const reportPath = format === "html" ? paths.html : join(stagingDir, "report.html");
    writeTabbedReport(reportPath, {
      title: "doctor collect",
      description: `biz-id: ${opts.bizIds.join(", ")} · 集合命令仅编排并汇总已有 collector`,
      ariaLabel: "采集结果",
      tabs,
    });
    const delivered = tabs.filter((tab) => tab.status === "delivered").length;
    let deliveryFailed = false;
    if (format === "default") {
      try {
        copyFileSync(reportPath, paths.html);
        terminalStdout.result(delivered > 0, `[collect] 集合 HTML: ${paths.html}\n`);
      } catch (error) {
        cleanupStaging = false;
        deliveryFailed = true;
        terminalStderr.error(
          `[collect] 集合 HTML 交付失败，证据保留在目录: ${stagingDir}（${error instanceof Error ? error.message : String(error)}）\n`,
        );
      }
    }
    if (format !== "html") {
      const packed = await packReportBundle(stagingDir, paths.bundle);
      if (!packed.ok) {
        cleanupStaging = false;
        terminalStderr.error(`[collect] 集合 Bundle 打包失败，证据保留在目录: ${stagingDir}\n`);
        return 1;
      }
      terminalStdout.result(delivered > 0, `[collect] 集合 Bundle: ${paths.bundle}\n`);
    } else {
      terminalStdout.result(delivered > 0, `[collect] 集合报告: ${paths.html}（${delivered}/${tabs.length} 已交付）\n`);
    }
    return delivered > 0 && !deliveryFailed ? 0 : 1;
  } finally {
    if (cleanupStaging) rmSync(stagingRoot, { recursive: true, force: true });
  }
}
