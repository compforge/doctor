import { ClientManager, clientKey } from "@compforge/harness-common";
import { healthCheckScope, validateHealthProbeResult, withSummary,
  type HealthCheckQuery, type HealthProbeExtension, type HealthProbeResult } from "@compforge/doctor-plugin";
import type { CommandContext } from "../command";
import { approvalDeniedReason } from "../command/approval";
import type { createPluginOperationInvoker } from "../plugin/operation-invoker";
import { useLogger } from "../terminal/log";
import type { HealthProvider } from "./extensions";
import type { HealthCheckResult } from "./flow";
import type { HealthInteraction } from "./interaction";

/** @spec Reuse belongs to one Health invocation and never changes Service ownership or ClientManager keys. */
export function createHealthProbeRunner(context: CommandContext, providers: readonly HealthProvider[],
  invoke: ReturnType<typeof createPluginOperationInvoker>, interaction: Pick<HealthInteraction, "approve" | "stopped">) {
  const results = new Map<string, { service: string; check: string; result: Partial<HealthCheckResult> }>();
  let discovery: Promise<boolean> | undefined;
  const denied = (): Partial<HealthCheckResult> => ({ status: interaction.stopped ? "not-run" : "skipped", summary: "未批准解析 DataSource 配置，未执行检查" });
  return async (provider: HealthProvider, check: HealthProbeExtension, query: HealthCheckQuery,
    checkpoint: (result: Partial<HealthCheckResult>) => void): Promise<Partial<HealthCheckResult>> => {
    const project = (value: HealthProbeResult): HealthProbeResult => {
      validateHealthProbeResult(value);
      return structuredClone({ status: value.status, summary: value.summary, evidence: value.evidence });
    };
    const save = (value: HealthProbeResult) => checkpoint(project(value));
    const approve = async (target = check.approval.target) => {
      if (healthCheckScope(check) === "self" && check.approval.risk === "observe") return { approved: true, source: "assume-yes" as const };
      return interaction.approve({ id: `healthcheck:${provider.namespace}:${check.id}`, title: check.description, ...check.approval, target });
    };
    const execute = async (run: () => Promise<HealthProbeResult>, target?: string): Promise<Partial<HealthCheckResult>> => {
      context.signal.throwIfAborted();
      const decision = await approve(target);
      if (!decision.approved) return { status: interaction.stopped || decision.source !== "prompt" ? "not-run" : "skipped", summary: approvalDeniedReason(decision.source) };
      context.signal.throwIfAborted();
      return project(await run());
    };
    if (!check.dataSource) return execute(() => invoke(provider.service, check, { ...query, checkpoint: save }));

    // One read-only discovery approval precedes all source resolution. No target client exists yet.
    discovery ??= interaction.approve({ id: "health-datasource-discovery", risk: "observe", title: "解析 Health 数据源配置并合并重复检查",
      target: providers.filter(provider => provider.checks.some(check => check.execution === "probe" && check.dataSource)).map(provider => provider.name).join(", "),
      impact: ["只读解析上述 Service 的数据源配置；不连接目标数据库、不执行健康探测或写入", "相同数据源的同类检查只批准和执行一次，各 Service 保留结果关联"] }).then(decision => decision.approved);
    if (!await discovery || interaction.stopped) return denied();
    context.signal.throwIfAborted();
    return invoke(provider.service, { access: check.access,
      run: withSummary({ title: check.description, fields: [] }, async (plugin, input) => {
        const source = await check.dataSource!(plugin, input);
        const id = source.id();
        if (typeof id !== "string" || !id.trim()) throw new Error("Health DataSource identity must be nonempty");
        const key = clientKey("health", { source: id, scope: check.kind, probe: check.probe, parameters: check.parameters ?? {}, risk: check.approval.risk });
        const previous = results.get(key);
        if (previous) {
          useLogger("health").info(`复用 ${previous.service}/${previous.check} 的检查结果：${provider.name}/${check.id}`);
          return { ...structuredClone(previous.result), dataSourceId: id, reusedFrom: { service: previous.service, check: previous.check } };
        }
        const result = await execute(async () => {
          const clients = new ClientManager(context.signal);
          try {
            return (await check.run(plugin, { ...input, client: () => clients.get(source), checkpoint: save })).data;
          } finally { await clients.dispose(); }
        }, source.description?.trim() || check.approval.target);
        const retained = { ...result, dataSourceId: id };
        if (!context.signal.aborted && !interaction.stopped && result.status !== "cancelled" && result.status !== "not-run") {
          results.set(key, { service: provider.name, check: check.id, result: structuredClone(retained) });
        }
        return retained;
      }),
    }, query);
  };
}
