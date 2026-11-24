import { clientKey } from "@compforge/harness-common";
import { HttpClient } from "@compforge/harness-toolbox/http";
import { MetricDBClient } from "@compforge/harness-toolbox/metricdb";
import { DirectTransport } from "@compforge/harness-toolbox/transport";
import type { CommandContext } from "../command";

/** The command owns pool lifetimes and budgets. Toolbox routes each operation and authenticates its endpoint. */
export async function openMetricDB(context: CommandContext, override?: string) {
  const profile = context.profile.value.metricdb;
  const url = override?.trim() || profile?.url;
  if (!url) return;
  const collector = url === profile?.url ? profile.collector : undefined;
  const reader = new MetricDBClient(async (endpoint) => {
    const limits = { concurrency: 4, connectTimeoutMs: 10_000, requestTimeoutMs: 30_000,
      maxResponseBytes: 4 * 1024 * 1024 };
    const target = { endpoint };
    const transport = await context.clients.get({ clientKey: clientKey("direct", {}), createClient: () => new DirectTransport() });
    return context.clients.get({ clientKey: clientKey("metricdb-http", { target, limits }),
      createClient: (_clients, signal) => new HttpClient(target, transport, limits, {signal}) });
  }, {...profile, url, collector});
  return {reader, configuredCollectorUrl: collector?.url};
}
