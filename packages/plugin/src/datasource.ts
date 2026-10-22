import { isFileDataSource, type ServiceFileDataSource } from "./file";
import type { ServiceCatalog } from "./catalog";
import type { ServiceDefinition } from "./service";
import type { DatabaseTarget } from "./database";
import type { PluginDataSource } from "./context";
import type { CapabilityWithAccess } from "./kubernetes";
import type { MysqlClient } from "@compforge/harness-toolbox/mysql";
import type { Client } from "@compforge/harness-common";
import type { S3Client, S3Target } from "@compforge/harness-toolbox/s3";
import type { RedisClient, RedisDataSourceTarget, RedisAccessApi } from "@compforge/harness-toolbox/redis/index";
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
 * @why A shared source lets db, store, metric and business Inspect reuse access without depending on each other.
 * @spec The Plugin resolves database configuration and any configuration Pod inside its source client.
 * @see {@link component://../../cli/docs/plugin.md}
 */
export type ServiceDatabaseDataSource = ServiceDataSourceBase & {
  kind: "db";
  backend: "mysql";
  source: PluginDataSource<MysqlClient<ServiceDatabaseTarget>>;
};

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

/**
 * @spec Redis configuration belongs to the Plugin; all consumers borrow one root-owned source.
 * @see {@link component://../../cli/docs/plugin.md}
 */
export type ServiceRedisDataSource = ServiceDataSourceBase & {
  kind: "redis";
  backend: "redis";
  source: PluginDataSource<ServiceRedisClient>;
};

/** Protocol clients retain their typed operations; configuration provenance is not evidence. */
export interface ServiceS3Client extends Client {
  readonly target: S3Target & { bucket: string; bucketPrefix?: string };
  readonly access: S3Client;
}

export interface ServiceVdbClient extends Client {
  readonly target: ServiceVdbTarget;
  readonly access: OpenSearchReadApi;
}

export type ServiceRedisTarget = RedisDataSourceTarget;
export type ServiceRedisClient = Pick<RedisClient, "initialize" | "dispose" | "target" | "topology"> & { readonly access: RedisAccessApi };

export type ServiceConnectionDataSource =
  | ServiceDatabaseDataSource
  | ServiceVdbDataSource
  | ServiceS3DataSource
  | ServiceRedisDataSource;

export type ServiceDataSource = ServiceConnectionDataSource | ServiceFileDataSource;

export function connectionDataSources(service: Pick<ServiceDefinition, "dataSources"> | undefined): readonly ServiceConnectionDataSource[] {
  return (service?.dataSources ?? []).filter((source): source is ServiceConnectionDataSource => !isFileDataSource(source));
}

export function fileDataSources(service: Pick<ServiceDefinition, "dataSources"> | undefined): readonly ServiceFileDataSource[] {
  return (service?.dataSources ?? []).filter(isFileDataSource);
}

export function serviceDataSources(
  catalog: ServiceCatalog,
  service: string,
  kind?: ServiceDataSourceKind,
): readonly ServiceConnectionDataSource[] {
  const dataSources = connectionDataSources(catalog.find(service));
  return kind ? dataSources.filter((store) => store.kind === kind) : dataSources;
}

export function findServiceDataSource(
  catalog: ServiceCatalog,
  service: string,
  sourceId: string,
): ServiceConnectionDataSource | undefined {
  return serviceDataSources(catalog, service).find((source) => source.id === sourceId);
}

export function servicesWithDataSource<T extends ServiceDefinition>(
  catalog: ServiceCatalog<T>,
  kind?: ServiceDataSourceKind,
): T[] {
  return catalog.services.filter((service) =>
    connectionDataSources(service).some((store) => !kind || store.kind === kind)
  );
}
