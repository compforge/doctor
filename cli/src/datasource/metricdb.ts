import { clientKey } from "@compforge/harness-common";
import { HttpClient } from "@compforge/harness-toolbox/http";
import { MetricDBClient, type ScrapeReader } from "@compforge/harness-toolbox/metricdb";
import { DirectTransport } from "@compforge/harness-toolbox/transport";
import type { CommandContext } from "../command";
import type { MetricDBProfileConfig, MetricEndpoint } from "../command/profile";

async function connectEndpoint(context: CommandContext, access: MetricEndpoint) {
  if (!!access.username !== !!access.password) throw new Error("metricdb.username / metricdb.password 必须成对配置");
  const limits = { concurrency: 4, connectTimeoutMs: 10_000, requestTimeoutMs: 30_000, maxResponseBytes: 4 * 1024 * 1024 };
  const transport = await context.clients.get({ clientKey: clientKey("direct", {}), createClient: () => new DirectTransport() });
  const target = { endpoint: access.url };
  const http = await context.clients.get({ clientKey: clientKey("metricdb-http", { target, limits }),
    createClient: (_clients, signal) => new HttpClient(target, transport, limits, { signal }) });
  const headers = access.username ? { Authorization: `Basic ${Buffer.from(`${access.username}:${access.password}`).toString("base64")}` } : undefined;
  return { http, options: { url: access.url, headers } };
}

export async function openScrapeReader(context: CommandContext, access: MetricEndpoint): Promise<ScrapeReader> {
  const { http, options } = await connectEndpoint(context, access);
  return new MetricDBClient(http, options);
}

/** An omitted kind probes the query dialect. Collector APIs are independent of that dialect. */
export async function openMetricDB(context: CommandContext, access: MetricDBProfileConfig): Promise<MetricDBClient> {
  const { http, options } = await connectEndpoint(context, access);
  return access.kind === undefined
    ? MetricDBClient.connect(http, options, context.signal)
    : new MetricDBClient(http, { ...options, kind: access.kind });
}
