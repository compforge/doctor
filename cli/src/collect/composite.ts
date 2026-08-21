import type { PluginDefinition } from "@compforge/doctor-plugin";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DOCTOR_CLI_VERSION } from "../app/version";
import type { CommandContext } from "../command";
import { terminalStderr } from "../terminal/output";
import { promptMultiSelect } from "../terminal/multi-select";
import { runCollectData } from "./data";
import { runCollectInspect } from "./inspect";
import { runCollectLog } from "./log";
import { runCollectMetric } from "./metric";
import { runCollectTenant } from "./tenant";
import { runCollectTrace } from "./trace";

export const COLLECT_KINDS = ["inspect", "tenant", "data", "trace", "log", "metric"] as const;
export type CollectKind = typeof COLLECT_KINDS[number];
export type CollectOutputFormat = "default" | "bundle" | "html";

const COLLECT_LABELS: Record<CollectKind, string> = {
  inspect: "Inspect · Service 运行态与配置",
  tenant: "Tenant · 租户粒度业务事实",
  data: "Data · 业务关联数据",
  trace: "Trace · 调用链与耗时",
  log: "Log · 关联日志",
  metric: "Metric · Service 指标",
};

export interface CollectCliOpts {
  bizIds: string[];
  kinds: CollectKind[];
  namespace?: string;
  tenantId?: string;
  tenantName?: string;
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

interface CollectManifestInput {
  opts: CollectCliOpts;
  plugin: Pick<PluginDefinition, "id" | "version">;
  results: readonly CollectDelegateResult[];
  commandContext: CommandContext;
  startedAt: string;
  finishedAt: string;
}

export function createCollectManifest(input: CollectManifestInput): Record<string, unknown> {
  const succeeded = input.results.filter((result) => result.code === 0).length;
  return {
    schema_version: 1,
    command: "doctor collect",
    status: succeeded === input.results.length ? "ok" : succeeded > 0 ? "partial" : "failed",
    doctor_version: DOCTOR_CLI_VERSION,
    plugin: {
      id: input.plugin.id,
      version: input.plugin.version,
    },
    target: {
      biz_ids: input.opts.bizIds,
      tenant_id: input.opts.tenantId,
      tenant_name: input.opts.tenantName,
      namespace: input.opts.namespace,
    },
    params: {
      include: input.opts.kinds,
      since: input.opts.since,
      since_time: input.opts.sinceTime,
      metric_watch: input.opts.watch,
      metric_interval: input.opts.interval,
      deployment_config: input.opts.deploymentConfig,
      dependencies: input.opts.dependencies,
    },
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    steps: input.results.map((result) => ({
      id: result.kind,
      title: COLLECT_LABELS[result.kind],
      status: result.code === 0 ? "ok" : "failed",
      exit_code: result.code,
      reason: result.error,
      artifacts: input.commandContext.artifacts.list()
        .filter((artifact) => artifact.command === result.kind)
        .map((artifact) => basename(artifact.path)),
    })),
  };
}

function registerCollectManifest(input: CollectManifestInput): void {
  const directory = mkdtempSync(join(tmpdir(), "doctor-collect-manifest-"));
  const path = join(directory, "manifest.json");
  writeFileSync(path, `${JSON.stringify(createCollectManifest(input), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  input.commandContext.artifacts.add("collect", path);
}

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
      case "tenant":
        code = await runCollectTenant({
          ...common,
          tenantId: opts.tenantId,
          tenantName: opts.tenantName,
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
 * Inspect, Tenant, Data, Trace, Log and Metric remain the sole owners of concrete collection work.
 */
export async function runCollect(
  opts: CollectCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
  injectedDelegate?: CollectDelegate,
): Promise<number> {
  if (!opts.bizIds.length && opts.kinds.some((kind) => (
    kind === "data" || kind === "trace" || kind === "log"
  ))) {
    terminalStderr.error("doctor collect 需要至少一个 biz-id\n");
    return 2;
  }
  const format = parseCollectOutputFormat(opts.format);
  commandContext.artifacts.setReportName(collectReportName(opts.bizIds));
  const startedAt = new Date().toISOString();
  const results = await runCollectDelegates(
    opts.kinds,
    injectedDelegate ?? collectDelegate(opts, plugin, commandContext),
  );
  if (format !== "html") {
    registerCollectManifest({
      opts,
      plugin,
      results,
      commandContext,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  }
  return results.some((result) => result.code === 0) ? 0 : 1;
}
