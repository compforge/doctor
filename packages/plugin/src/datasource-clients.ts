import { Transport as ManagedTransport } from "@compforge/harness-toolbox/transport";
import { clientKey, type Client, type Identity } from "@compforge/harness-common";
import { PortForwardTransport, type TcpTransport } from "@compforge/harness-toolbox/transport";
import { serviceIdentity } from "@compforge/harness-toolbox/kubernetes/service";
import type { PluginClientContext, PluginDataSource } from "./context";
import { MysqlClient } from "@compforge/harness-toolbox/db/mysql";
import { RedisClient } from "@compforge/harness-toolbox/kv/redis";
import type { ServiceS3Client, ServiceVdbClient, ServiceRedisClient, ServiceDatabaseTarget } from "./datasource";

function kubernetesTransport(context: PluginClientContext): PortForwardTransport {
  return new PortForwardTransport(async endpoint => {
    const service = serviceIdentity(endpoint.host, context.target.namespace);
    if (!service) return endpoint;
    // The endpoint's Service namespace can differ from the configuration source's namespace.
    // Keep Host/SNI unchanged; the host enforces declared access on the selected scope.
    return context.infra.kubernetes.inNamespace(service.namespace).portForward(endpoint);
  });
}

/** Keep resolved target metadata with its typed client, under the host's single lifecycle. */
function configuredSource<T, C extends Client>(key: string,
  resolve: (context: PluginClientContext) => Promise<T>,
  connect: (target: T, context: PluginClientContext) => Promise<{ access: C; dataSource?: Identity }>,
) {
  return { clientKey: key, createClient: (context: PluginClientContext) => {
    let target: T;
    let connection: Awaited<ReturnType<typeof connect>>;
    return {
      get target() { return target; },
      get access() { return connection?.access; },
      get dataSource() { return connection?.dataSource; },
      async initialize() {
        target = await resolve(context);
        connection = await connect(target, context);
        await connection.access.initialize();
      },
      async dispose() { await connection?.access.dispose(); },
    };
  } };
}

export function s3DataSource(key: string, resolve: (context: PluginClientContext) => Promise<ServiceS3Client["target"]>): PluginDataSource<ServiceS3Client> {
  return configuredSource(key, resolve, async (target, context) => {
    const { S3Client, S3DataSource } = await import("@compforge/harness-toolbox/s3");
    const endpoint = new URL(target.endpoint);
    const configuration = { endpoint: endpoint.toString(), region: target.region, credentials: target.credentials,
      ca: target.ca, forcePathStyle: target.forcePathStyle ?? true };
    const transport = kubernetesTransport(context);
    const service = serviceIdentity(endpoint.hostname, context.target.namespace);
    const route = service ? clientKey("s3-route", { environment: context.target.env, service }) : "direct";
    const limits = { concurrency: 4, connectTimeoutMs: 10_000, requestTimeoutMs: 10_000 };
    return {
      access: new S3Client(configuration, new ManagedTransport([transport]), limits, { signal: context.signal }),
      dataSource: new S3DataSource(configuration, limits, { key: route, transport }),
    };
  });
}

export function vdbDataSource(key: string, resolve: (context: PluginClientContext) => Promise<ServiceVdbClient["target"]>): PluginDataSource<ServiceVdbClient> {
  return configuredSource(key, resolve, async (target, context) => {
    const { OpenSearchClient } = await import("@compforge/harness-toolbox/vectordb/opensearch");
    if (target.backend !== "opensearch" || !target.endpoint) throw new Error("VDB source 需要 opensearch endpoint");
    return { access: new OpenSearchClient(async () => ({ node: target.endpoint!,
      auth: { username: target.username, password: target.password }, requestTimeoutMs: 15_000 }), new ManagedTransport([kubernetesTransport(context)]), { signal: context.signal }) };
  });
}

export function redisDataSource(key: string, resolve: (context: PluginClientContext) => Promise<ServiceRedisClient["target"]>): PluginDataSource<ServiceRedisClient> {
  return {
    clientKey: key,
    createClient: context => new RedisClient(() => resolve(context), new ManagedTransport(tcpTransports(context)), { signal: context.signal }),
  };
}

/** Native connections first, then a root-owned relay; protocol clients never dispose borrowed transports. */
export function tcpTransports(context: PluginClientContext): TcpTransport[] {
  return [
    kubernetesTransport(context),
    { kind: "tcp", name: "pod-relay", connect: endpoint => context.infra.kubernetes.podRelay(endpoint) },
  ];
}

/** Factory resolution receives root-owned access, never captures a short-lived capability context. */
export function mysqlDataSource(
  key: string,
  resolve: (context: PluginClientContext) => Promise<ServiceDatabaseTarget>,
): PluginDataSource<MysqlClient<ServiceDatabaseTarget>> {
  return {
    clientKey: key,
    createClient: context => new MysqlClient(() => resolve(context), new ManagedTransport(tcpTransports(context)), { signal: context.signal, connectTimeoutMs: 10_000, queryTimeoutMs: 15_000 }),
  };
}
