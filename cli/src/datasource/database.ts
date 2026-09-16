import { mysqlDataSource, type ServiceDatabaseDataSource, type ServiceDatabaseTarget } from "@compforge/doctor-plugin";
import { dataSourceKey } from "@compforge/harness-common";
import type { Executor, ExecResult } from "@compforge/harness-toolbox/kubernetes/executor";
import { parseMysqlEnvTarget, type MysqlClient } from "../infra/database/mysql";
import { resolveKubernetesCommandContext, type CommandContext } from "../command";
import { createKubernetesExecutor, resolveKubernetesCommandConfig, resolvePodTarget, type KubernetesCommandConfig, type KubernetesCommandInput, type PodTarget } from "../command/kubernetes-target";
import { openPluginContext } from "../plugin/context";
import { configuredValue, loadServiceRuntimeConfig } from "./runtime-config";
import { resolveDataSourcePod } from "./workload";
import { enforceKubernetesAccess } from "../terminal/kubernetes-access";
import { ParameterCancelled } from "../terminal/parameters";

export interface DatabaseSourceConfig {
  collect: KubernetesCommandConfig;
  service: string;
  capability: ServiceDatabaseDataSource;
  target?: PodTarget;
}

export interface ResolvedDatabase {
  target?: ServiceDatabaseTarget;
  source: string;
  captures: ExecResult[];
  reason?: string;
}

export async function resolveDatabaseConfig(
  command: CommandContext,
  input: KubernetesCommandInput & { pod?: string; container?: string },
  service: string,
  capability: ServiceDatabaseDataSource,
  interactive: boolean,
): Promise<{ config: DatabaseSourceConfig; executor: Executor }> {
  const collect = await resolveKubernetesCommandConfig({ ...input, interactive }, undefined, command);
  if (!collect) throw new ParameterCancelled();
  const executor = createKubernetesExecutor(collect);
  const config: DatabaseSourceConfig = { collect, service, capability };
  if (capability.source) return { config, executor };
  const access = resolveKubernetesCommandContext(executor, command).access;
  await enforceKubernetesAccess(access, {
    command: "doctor · database",
    needs: [
      { requirement: "required", rule: { verb: "list", resource: "services" }, purpose: "定位数据源配置来源 Service" },
      { requirement: "required", rule: { verb: "list", resource: "pods" }, purpose: "定位数据源配置来源 Pod" },
      { requirement: "preferred", rule: { verb: "get", resource: "configmaps" }, purpose: "读取数据库配置", fallback: "读取 Container env" },
      { requirement: "preferred", rule: { verb: "get", resource: "secrets" }, purpose: "读取数据库凭据", fallback: "读取 Container env" },
      { requirement: "preferred", rule: { verb: "create", resource: "pods/exec" }, purpose: "补充数据库运行时配置", fallback: "标记数据源 unavailable" },
    ],
  });
  const selection = { candidateRole: "配置来源", purpose: `读取 Service '${service}' 的数据库配置`, effect: "配置来源不限定 SQL 查询范围。" };
  const pod = await resolveDataSourcePod({
    service, pod: input.pod, executor, namespace: collect.kubernetes.namespace,
    interactive, commandContext: command, selection,
  });
  if (!pod) throw new ParameterCancelled();
  config.target = await resolvePodTarget({
    config: collect, executor, pod, container: input.container, selectContainer: true,
    interactive, access, commandContext: command, selection,
  });
  if (!config.target) throw new ParameterCancelled();
  return { config, executor };
}

/** Configuration and access are shared by all consumers; neither belongs to the store command. */
export async function resolveDatabaseTarget(
  config: DatabaseSourceConfig, executor: Executor, command: CommandContext,
): Promise<ResolvedDatabase> {
  if (config.capability.source) {
    const client = await borrowDatabase(command, config, executor);
    return { target: client.target, source: "plugin", captures: [] };
  }
  const prefix = config.capability.envPrefix;
  if (!config.target || !prefix) throw new Error("DB DataSource 未提供配置解析入口");
  const required = (env: Map<string, string>) => !!(
    configuredValue(env, `${prefix}_HOST`)
    && (configuredValue(env, `${prefix}_DATABASE`) || configuredValue(env, `${prefix}_NAME`))
    && (configuredValue(env, `${prefix}_USERNAME`) || configuredValue(env, `${prefix}_USER`))
    && configuredValue(env, `${prefix}_PASSWORD`)
  );
  const runtime = await loadServiceRuntimeConfig(executor, config.target, required);
  if (!required(runtime.environment)) return {
    source: runtime.source, captures: runtime.captures,
    reason: runtime.reason ?? `Service '${config.service}' 未提供完整的 ${prefix}_* DB 配置`,
  };
  return {
    source: runtime.source, captures: runtime.captures,
    target: {
      ...parseMysqlEnvTarget([...runtime.environment].map(([key, value]) => `${key}=${value}`).join("\n"), { label: config.service, prefix }),
      source: { namespace: config.collect.kubernetes.namespace, ...config.target },
    },
  };
}

/** @spec Client identity is shared within the same Service, environment, configuration and declared access. */
export async function borrowDatabase(
  command: CommandContext, config: DatabaseSourceConfig, executor: Executor, target?: ServiceDatabaseTarget,
): Promise<MysqlClient<ServiceDatabaseTarget>> {
  const source = config.capability.source ?? (target
    ? mysqlDataSource(dataSourceKey("mysql", target), async () => target)
    : undefined);
  if (!source) throw new Error("DB DataSource 未提供访问目标");
  const context = await openPluginContext(executor, {
    namespace: config.collect.kubernetes.namespace,
    kubeconfig: config.collect.kubernetes.kubeconfig,
    context: config.collect.kubernetes.context,
  }, {
    clients: command.clients,
    env: config.collect.profileName,
    config: command.profile.pluginConfig,
    service: { name: config.service },
    command: "doctor · database",
    capability: { access: config.capability.source ? config.capability.access ?? {} : {
      kubernetes: [{ requirement: "required", rule: { verb: "create", resource: "pods/portforward" }, purpose: "访问 Service 声明的数据库" }],
    } },
    authorization: resolveKubernetesCommandContext(executor, command).access,
  });
  try { return await context.clients.get(source); }
  finally { await context.dispose(); }
}
