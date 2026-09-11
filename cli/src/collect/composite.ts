import type { PluginDefinition } from "@compforge/doctor-plugin";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_CLI_VERSION } from "../app/version";
import {
  aggregateCommandStatus,
  CommandInputError,
  CommandStatus,
  defineCommand,
  type CommandContext,
  type CommandInput,
  type CommandResult,
} from "../command";
import type { CommandHostOption } from "../command/options";
import { failureReport } from "../report/context";
import { composeReports } from "../report/model";
import { promptMultiSelect } from "../terminal/multi-select";
import { dataCommand } from "./data/command";
import { createInspectInput, inspectCommand } from "./inspect/command";
import { logCommand } from "./log/command";
import { metricCommand } from "./metric/command";
import { createTenantInput, tenantCommand } from "./tenant/command";
import { traceCommand } from "./trace/command";

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
  bizIds: readonly string[];
  itemConcurrency?: number;
  kinds: CollectKind[];
  namespace?: string;
  tenantId?: string;
  tenantName?: string;
  since?: string;
  sinceTime?: string;
  untilTime?: string;
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

export type CollectInput = CommandInput & Omit<CollectCliOpts, CommandHostOption>;

export interface CollectDelegateResult {
  readonly kind: CollectKind;
  readonly result: CommandResult<unknown>;
}

export interface CollectOutput { readonly steps: readonly CollectDelegateResult[]; }
export type CollectDelegate = (kind: CollectKind) => Promise<CommandResult<unknown>>;

interface CollectManifestInput {
  opts: CollectInput;
  plugin: Pick<PluginDefinition, "id" | "version">;
  results: readonly CollectDelegateResult[];
  commandContext: CommandContext;
  startedAt: string;
  finishedAt: string;
}

export function createCollectManifest(input: CollectManifestInput): Record<string, unknown> {
  return {
    schema_version: 3,
    command: "doctor collect",
    status: aggregateCommandStatus(input.results.map((step) => step.result.status)),
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
      until_time: input.opts.untilTime,
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
      status: result.result.status,
      reason: "reason" in result.result ? result.result.reason : undefined,
      artifact_ids: result.result.artifacts.map((artifact) => artifact.id),
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
  input.commandContext.artifacts.add({ command: "collect", path });
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
    const result = await delegate(kind);
    results.push({ kind, result });
    if (result.status === CommandStatus.Cancelled) break;
  }
  return results;
}

function providerNames(plugin: PluginDefinition, capability: "inspect" | "log" | "metric"): string {
  const services = capability === "inspect"
    ? plugin.services.servicesWithContribution("inspect")
    : plugin.services.servicesWith(capability);
  return services.map((service) => service.name).join(",");
}

/** biz-id 不能推导 Service 范围；组合执行时显式采用 Plugin 声明的完整业务 Service 边界。 */
function inspectServiceNames(plugin: PluginDefinition): string {
  return plugin.services.services.map((service) => service.name).join(",");
}

function collectDelegate(input: CollectInput, context: CommandContext): CollectDelegate {
  const plugin = context.plugin;
  const common = { namespace: input.namespace };
  return (kind) => {
    switch (kind) {
      case "inspect": return inspectCommand.run(context, createInspectInput({
        ...common, services: inspectServiceNames(plugin),
        deploymentConfig: input.deploymentConfig, dependencies: input.dependencies,
      }));
      case "tenant": return tenantCommand.run(context, createTenantInput({
        ...common, tenantId: input.tenantId, tenantName: input.tenantName,
      }));
      case "data": return dataCommand.run(context, {
        ...common, bizIds: input.bizIds, services: providerNames(plugin, "inspect"),
      });
      case "trace": return traceCommand.run(context, { ...common, bizIds: input.bizIds });
      case "log": return logCommand.run(context, {
        ...common, bizIds: input.bizIds,
        // Capability availability is broader than the Plugin's default collection scope.
        services: plugin.services.servicesWith("log")
          .filter((service) => service.capabilities.log.default).map((service) => service.name).join(","),
        since: input.since, sinceTime: input.sinceTime, untilTime: input.untilTime, itemConcurrency: input.itemConcurrency,
      });
      case "metric": return metricCommand.run(context, {
        ...common, services: providerNames(plugin, "metric"), watch: input.watch ?? "0",
        interval: input.interval, prometheus: input.prometheus,
      });
    }
  };
}

/** Each selected command checks its own requirements so missing optional collectors cannot veto siblings. */
export function createCollectCommand(delegate?: CollectDelegate) {
  return defineCommand<CollectInput, CollectOutput>({
    name: "doctor collect",
    render: async (context, result) => {
      if (!result.output) return failureReport("doctor collect", result);
      const reports = [];
      for (const step of result.output?.steps ?? []) {
        switch (step.kind) {
          case "inspect": reports.push(await context.render(inspectCommand, step.result)); break;
          case "tenant": reports.push(await context.render(tenantCommand, step.result)); break;
          case "data": reports.push(await context.render(dataCommand, step.result)); break;
          case "trace": reports.push(await context.render(traceCommand, step.result)); break;
          case "log": reports.push(await context.render(logCommand, step.result)); break;
          case "metric": reports.push(await context.render(metricCommand, step.result)); break;
        }
      }
      return composeReports("doctor collect", reports);
    },
    plugin: { command: "doctor collect", needs: [] },
    validate: (input) => {
      if (!input.bizIds.length && input.kinds.some((kind) => ["data", "trace", "log"].includes(kind))) {
        throw new CommandInputError("doctor collect 需要至少一个 biz-id");
      }
    },
    run: async (context, input) => {
      context.artifacts.setReportName(collectReportName(input.bizIds));
      const startedAt = new Date().toISOString();
      const invoke = delegate ?? collectDelegate(input, context);
      const results = await runCollectDelegates(input.kinds, async (kind) => {
        context.signal.throwIfAborted();
        const result = await invoke(kind);
        context.artifacts.add(result.artifacts);
        return result;
      });
      registerCollectManifest({
        opts: input, plugin: context.plugin, results, commandContext: context,
        startedAt, finishedAt: new Date().toISOString(),
      });
      return {
        status: aggregateCommandStatus(results.map((step) => step.result.status)),
        output: { steps: results }, artifacts: context.artifacts.list(),
      };
    },
  });
}

export const collectCommand = createCollectCommand();
