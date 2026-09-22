import type { ServiceCatalog } from "./catalog";
import type { ServiceDefinition } from "./service";
import type { DatabaseTarget } from "./database";
import type { PluginClientContext, PluginDataSource } from "./context";
import type { CapabilityWithAccess } from "./kubernetes";
import { MysqlClient } from "@compforge/harness-toolbox/mysql";
import { PortForwardTransport, type TcpTransport } from "@compforge/harness-toolbox/transport";
import type { Client } from "@compforge/harness-common";
import type { S3Client, S3Target } from "@compforge/harness-toolbox/s3";
import type { RedisAccessApi } from "@compforge/harness-toolbox/redis/index";
import type { OpenSearchReadApi } from "@compforge/harness-toolbox/opensearch/client";

export type ServiceDataSourceKind = "db" | "vdb" | "s3" | "redis";

interface ServiceDataSourceBase {
  id: string;
  kind: ServiceDataSourceKind;
  description?: string;
  access?: CapabilityWithAccess["access"];
}

export interface ServiceDatabaseTarget extends DatabaseTarget {
  /** Configuration provenance only; no credentials or raw configuration. */
  source?: { namespace?: string; pod?: string; container?: string; path?: string };
}

/**
 * @spec Service declares access, not query results; clients are borrowed from the root lifecycle.
 * @why A shared source lets db, store and business Inspect reuse access without depending on each other.
 */
export type ServiceDatabaseDataSource = ServiceDataSourceBase & {
  kind: "db";
  backend: "mysql";
} & ({
  envPrefix: string;
  source?: never;
} | {
  envPrefix?: never;
  source: PluginDataSource<MysqlClient<ServiceDatabaseTarget>>;
});

export interface ServiceVdbTarget {
  backend: string;
  store: string;
  endpoint?: string;
  username?: string;
  password?: string;
  configurationKind: string;
  configPath?: string;
  source?: {
    namespace?: string;
    pod?: string;
    container?: string;
  };
}

export interface ServiceVdbConfigurationInput {
  environment: Readonly<Record<string, string>>;
  file?: {
    path: string;
    content: string;
  };
}

export interface ServiceVdbConfiguration {
  /** Doctor 负责读取文件；路径规则及文件内容语义由 Plugin 拥有。 */
  file?: {
    pathEnvironment: string;
    defaultPath: string;
  };
  resolve(
    input: ServiceVdbConfigurationInput,
  ): ServiceVdbTarget | Promise<ServiceVdbTarget>;
}

export interface ServiceVdbDataSource extends ServiceDataSourceBase {
  kind: "vdb";
  backend: "opensearch";
  store?: string;
  source?: PluginDataSource<ServiceVdbClient>;
  access?: CapabilityWithAccess["access"];
  /** 非标准 VDB 配置由 Plugin 投影为 Doctor 可消费的统一 target。 */
  configuration?: ServiceVdbConfiguration;
}

export type ServiceS3DataSource = ServiceDataSourceBase & {
  kind: "s3";
  backend: "s3-compatible";
} & ({ source: PluginDataSource<ServiceS3Client>; environment?: never } | {
  source?: never;
  environment: {
    endpoint: string;
    bucket: string;
    region: string;
    accessKey: string;
    secretKey: string;
    bucketPrefix?: string;
    addressStyle?: string;
  };
});

export type ServiceRedisDataSource = ServiceDataSourceBase & {
  kind: "redis";
  backend: "redis";
} & ({ source: PluginDataSource<ServiceRedisClient>; environment?: never } | {
  source?: never;
  environment: {
    address: string;
    port?: string;
    database?: string;
    username?: string;
    password?: string;
    useSsl?: string;
    clusterType?: string;
    sentinels?: string;
    sentinelMasterName?: string;
    sentinelUsername?: string;
    sentinelPassword?: string;
    timeout?: string;
  };
});

/** Protocol clients retain their typed operations; configuration provenance is not evidence. */
export interface ServiceS3Client extends Client {
  readonly target: S3Target & { bucket: string; bucketPrefix?: string };
  readonly access: S3Client;
}

export interface ServiceVdbClient extends Client {
  readonly target: ServiceVdbTarget;
  readonly access: OpenSearchReadApi;
}

export interface ServiceRedisTarget {
  endpoints: Array<[host: string, port: number]>;
  database: number;
  username?: string;
  password?: string;
  useSsl: boolean;
  clusterType: "single" | "sentinel" | "cluster";
  /** Connection and command timeout in seconds, matching the Redis collection configuration. */
  timeout: number;
  sentinelHosts: Array<[string, number]>;
  sentinelMasterName: string;
  sentinelUsername?: string;
  sentinelPassword?: string;
}

export interface ServiceRedisClient extends Client {
  readonly target: ServiceRedisTarget;
  readonly access: RedisAccessApi;
}

export type ServiceDataSource =
  | ServiceDatabaseDataSource
  | ServiceVdbDataSource
  | ServiceS3DataSource
  | ServiceRedisDataSource;

/** Native connections first, then a root-owned relay; protocol clients never dispose borrowed transports. */
export function mysqlTransports(context: PluginClientContext): TcpTransport[] {
  return [
    new PortForwardTransport(endpoint => context.infra.kubernetes.portForward(endpoint)),
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
    createClient: context => new MysqlClient({
      resolve: () => resolve(context),
      transports: mysqlTransports(context),
    }, { signal: context.signal, connectTimeoutMs: 10_000, queryTimeoutMs: 15_000 }),
  };
}

export function serviceDataSources(
  catalog: ServiceCatalog,
  service: string,
  kind?: ServiceDataSourceKind,
): readonly ServiceDataSource[] {
  const dataSources = catalog.find(service)?.dataSources ?? [];
  return kind ? dataSources.filter((store) => store.kind === kind) : dataSources;
}

export function findServiceDataSource(
  catalog: ServiceCatalog,
  service: string,
  sourceId: string,
): ServiceDataSource | undefined {
  return serviceDataSources(catalog, service).find((source) => source.id === sourceId);
}

export function servicesWithDataSource<T extends ServiceDefinition>(
  catalog: ServiceCatalog<T>,
  kind?: ServiceDataSourceKind,
): T[] {
  return catalog.services.filter((service) =>
    service.dataSources?.some((store) => !kind || store.kind === kind)
  );
}
