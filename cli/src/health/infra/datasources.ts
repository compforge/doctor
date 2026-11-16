import type { HealthInteraction } from "../interaction";
import type { ServiceDependencyRuntime } from "../../collect/shared/service-dependency";
import type { DataSourceHealthSession } from "../../datasource/health/session";
import type { HealthProvider } from "../extensions";
import type { HealthDataSourceCheck } from "../flow";

export async function checkHealthDataSources(provider: HealthProvider, sources: ServiceDependencyRuntime,
  session: DataSourceHealthSession, signal: AbortSignal, interaction?: HealthInteraction): Promise<HealthDataSourceCheck[]> {
  const results: HealthDataSourceCheck[] = [];
  for (const reference of provider.dataSources ?? []) {
    if (signal.aborted || interaction?.stopped) break;
    try {
      const prepared = await sources.prepareDataSource(reference.service, reference.dataSource);
      if (interaction) {
        const decision = await interaction.approveOnce(JSON.stringify(["datasource", reference.service, reference.dataSource]), {
          id: "health-datasource", risk: "observe", title: "OpenSearch 数据源健康检查",
          target: `${reference.service}/${reference.dataSource} · ${String(prepared.evidenceTarget.endpoint ?? "Plugin 提供的连接")}`,
          impact: ["从 Doctor Host 经已配置的访问通道读取集群、节点、磁盘水位和索引状态。"],
        });
        if (!decision.approved) {
          results.push({ ...reference, status: interaction.stopped ? "not-run" : "skipped",
            reason: interaction.stopped ? "用户结束巡检" : "用户跳过数据源检查" });
          continue;
        }
      }
      const health = await session.probe(prepared.search, signal);
      results.push({ ...reference, evidence: { target: { ...prepared.evidenceTarget, ...reference }, health } });
    } catch (error) {
      results.push({ ...reference, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
