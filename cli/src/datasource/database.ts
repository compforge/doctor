import type { ServiceDatabaseDataSource, ServiceDatabaseTarget } from "@compforge/doctor-plugin";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
import type { MysqlClient } from "../infra/database/mysql";
import type { CommandContext } from "../command";
import { createKubernetesExecutor, resolveKubernetesCommandConfig, type KubernetesCommandConfig, type KubernetesCommandInput } from "../command/kubernetes-target";
import { borrowServiceClient } from "./client";
import { ParameterCancelled } from "../terminal/parameters";

export interface DatabaseSourceConfig {
  collect: KubernetesCommandConfig;
  service: string;
  capability: ServiceDatabaseDataSource;
}

export async function resolveDatabaseConfig(
  command: CommandContext,
  input: KubernetesCommandInput,
  service: string,
  capability: ServiceDatabaseDataSource,
  interactive: boolean,
): Promise<{ config: DatabaseSourceConfig; executor: Executor }> {
  const collect = await resolveKubernetesCommandConfig({ ...input, interactive }, undefined, command);
  if (!collect) throw new ParameterCancelled();
  return { config: { collect, service, capability }, executor: createKubernetesExecutor(collect) };
}

/**
 * @spec Core borrows an initialized database client; configuration and replica selection belong to the Plugin source.
 * @spec Client identity is shared within the same Service, environment, configuration and declared access.
 * @see {@link component://docs/plugin.md}
 */
export async function borrowDatabase(
  command: CommandContext, config: DatabaseSourceConfig, executor: Executor,
): Promise<MysqlClient<ServiceDatabaseTarget>> {
  return borrowServiceClient(command, config.collect, executor, config.service, config.capability, config.capability.source);
}
