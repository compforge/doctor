import { clientKey } from "@compforge/harness-common";
import { HttpClient } from "@compforge/harness-toolbox/http";
import { MetricDBClient } from "@compforge/harness-toolbox/metricdb";
import { DirectTransport } from "@compforge/harness-toolbox/transport";
import { CommandInputError, type CommandContext } from "../command";
import type { MetricDBProfileConfig } from "../command/profile";

/** @rule Authentication, dialect and collector belong to the selected query endpoint, including its tenant path. */
export function resolveMetricDBConfig(profile: MetricDBProfileConfig | undefined, override?: string) {
  if (override === undefined) return profile?.url.trim() ? profile : undefined;
  const url = override.trim();
  if (!url) throw new CommandInputError("--prometheus 不能为空");
  return profile && url.replace(/\/$/, "") === profile.url.replace(/\/$/, "") ? profile : { url };
}

/** The command owns pool lifetimes and budgets. Toolbox routes each operation and authenticates its endpoint. */
export function openMetricDB(context: CommandContext, config: MetricDBProfileConfig) {
  const reader = new MetricDBClient(async (endpoint) => {
    const limits = { concurrency: 4, connectTimeoutMs: 10_000, requestTimeoutMs: 30_000,
      maxResponseBytes: 4 * 1024 * 1024 };
    const target = { endpoint };
    const transport = await context.clients.get({ clientKey: clientKey("direct", {}), createClient: () => new DirectTransport() });
    return context.clients.get({ clientKey: clientKey("metricdb-http", { target, limits }),
      createClient: (_clients, signal) => new HttpClient(target, transport, limits, {signal}) });
  }, config);
  return {reader, configuredCollectorUrl: config.collector?.url};
}
