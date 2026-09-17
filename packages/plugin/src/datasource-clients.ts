import type { Client } from "@compforge/harness-common";
import { PortForwardTransport } from "@compforge/harness-toolbox/transport";
import { serviceIdentity } from "@compforge/harness-toolbox/kubernetes/service";
import type { PluginClientContext, PluginDataSource } from "./context";
import type { ServiceS3Client, ServiceVdbClient, ServiceRedisClient } from "./datasource";

function kubernetesTransport(context: PluginClientContext): PortForwardTransport {
  return new PortForwardTransport(async endpoint => serviceIdentity(endpoint.host, context.target.namespace)
    ? context.infra.kubernetes.portForward(endpoint) : endpoint);
}

/** Keep resolved target metadata with its typed client, under the host's single lifecycle. */
function configuredSource<T, C extends Client, A>(key: string,
  resolve: (context: PluginClientContext) => Promise<T>,
  connect: (target: T, context: PluginClientContext) => C | Promise<C>,
  access: (client: C) => A,
): PluginDataSource<Client & { readonly target: T; readonly access: A }> {
  return { clientKey: key, createClient: context => {
    let target: T;
    let client: C;
    return {
      get target() { return target; },
      get access() { return access(client); },
      async initialize() {
        target = await resolve(context);
        client = await connect(target, context);
        await client.initialize();
      },
      async dispose() { await client?.dispose(); },
    };
  } };
}

export function s3DataSource(key: string, resolve: (context: PluginClientContext) => Promise<ServiceS3Client["target"]>): PluginDataSource<ServiceS3Client> {
  return configuredSource(key, resolve, async (target, context) => {
    const { S3Client } = await import("@compforge/harness-toolbox/s3");
    return new S3Client({ resolve: async () => target,
      transports: [kubernetesTransport(context)],
    }, { concurrency: 4, connectTimeoutMs: 10_000, requestTimeoutMs: 10_000 }, { signal: context.signal });
  }, client => client);
}

export function vdbDataSource(key: string, resolve: (context: PluginClientContext) => Promise<ServiceVdbClient["target"]>): PluginDataSource<ServiceVdbClient> {
  return configuredSource(key, resolve, async (target, context) => {
    const { OpenSearchClient } = await import("@compforge/harness-toolbox/opensearch/client");
    if (target.backend !== "opensearch" || !target.endpoint) throw new Error("VDB source 需要 opensearch endpoint");
    return new OpenSearchClient({ resolve: async () => ({ node: target.endpoint!,
      auth: { username: target.username, password: target.password }, requestTimeoutMs: 15_000 }),
      transports: [kubernetesTransport(context)],
    }, { signal: context.signal });
  }, client => client);
}

export function redisDataSource(key: string, resolve: (context: PluginClientContext) => Promise<ServiceRedisClient["target"]>): PluginDataSource<ServiceRedisClient> {
  return configuredSource(key, resolve, async (target, context) => {
    const { RedisClient } = await import("@compforge/harness-toolbox/redis/index");
    return new RedisClient({
      resolve: async () => ({ endpoints: target.endpoints.map(([host, port]) => ({ host, port })),
        database: target.database, useSsl: target.useSsl, timeoutMs: target.timeout * 1_000,
        username: target.username, password: target.password }),
      transports: [kubernetesTransport(context)],
    }, { signal: context.signal });
  }, client => client.access);
}
