import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, resolveProfile } from "../../app/config/config";
import type { ServiceCatalog } from "@compforge/doctor-plugin";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type {
  TenantDirectory,
  TenantSummary,
} from "@compforge/doctor-plugin";
import { resolveCollectKubeconfig, resolveCollectNamespace } from "../../infra/k8s/context";
import type { Executor } from "../../infra/k8s/executor";
import {
  listServiceChoices,
  rankRecentServiceChoices,
  recordRecentServiceTargets,
  type ServiceChoice,
} from "../../infra/k8s/service-selection";
import {
  recentSelectionsForInteractive,
  type RecentSelections,
} from "../../infra/recent";
import { promptNamedChoices } from "../../terminal/service-selection";
import { prepareTerminalInput } from "../../terminal/input";
import { terminalStdout } from "../../terminal/output";
import {
  promptTenantChoice,
  type TenantPromptChoice,
} from "../../terminal/tenant-selection";
import type {
  CollectConfigCliOpts,
  ConfigCollectConfig,
  ConfigOutputFormat,
} from "./model";
import type { CommandContext } from "../../command";

export { resolveTenantPromptChoice } from "../../terminal/tenant-selection";

export function parseConfigServices(raw: string, catalog: ServiceCatalog): string[] {
  const services = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
  if (!services.length) throw new Error("--services 未解析出任何 Service");
  const unsupported = services.filter((service) => !catalog.findWith(service, "config"));
  if (unsupported.length) {
    throw new Error(`Doctor 未注册以下 Service 的配置采集能力：${unsupported.join(", ")}`);
  }
  return services;
}

export function parseConfigOutputFormat(value: string | undefined): ConfigOutputFormat {
  const format = value?.trim() || "html";
  if (format !== "json" && format !== "html" && format !== "md") {
    throw new Error(`--format 只支持 json、html 或 md: '${format}'`);
  }
  return format;
}

function parsePort(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${flag} 必须是 1..65535 的整数`);
  return port;
}

export function configReportName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `doctor-config-${timestamp}`;
}

export function resolveConfigHtmlOutputPath(output: string | undefined, reportName: string): string {
  if (!output) return join(".", `${reportName}.html`);
  if (/\.(?:tar\.gz|tgz)$/i.test(output)) {
    throw new Error("--format html 的输出路径不能使用 .tar.gz/.tgz 后缀");
  }
  return output.toLowerCase().endsWith(".html") ? output : `${output}.html`;
}

export function resolveConfigMarkdownOutputPath(output: string | undefined, reportName: string): string {
  if (!output) return join(".", `${reportName}.md`);
  if (/\.(?:tar\.gz|tgz|html)$/i.test(output)) {
    throw new Error("--format md 的输出路径不能使用 .tar.gz/.tgz/.html 后缀");
  }
  return output.toLowerCase().endsWith(".md") ? output : `${output}.md`;
}

export function resolveConfigCollectConfig(
  opts: CollectConfigCliOpts,
  plugin: PluginDefinition,
  commandContext?: CommandContext,
): ConfigCollectConfig {
  const format = parseConfigOutputFormat(opts.format);
  if (format === "json" && opts.output) throw new Error("--output 仅在 --format html 或 md 时可用");
  const reportName = configReportName(new Date());
  const outputPath = format === "html"
    ? resolveConfigHtmlOutputPath(opts.output, reportName)
    : format === "md"
      ? resolveConfigMarkdownOutputPath(opts.output, reportName)
      : undefined;
  const configPath = opts.config ?? process.env.DOCTOR_CONFIG ?? join(homedir(), ".doctor", "config.yaml");
  const resolvedProfile = commandContext
    ? { name: commandContext.profile.name, profile: commandContext.profile.value }
    : resolveProfile(loadConfig(configPath), opts.profile);
  const profile = resolvedProfile.profile;
  const fallbackIdentity = profile.db?.user && profile.db.password
    ? { user: profile.db.user, password: profile.db.password }
    : undefined;
  const kubeconfig = resolveCollectKubeconfig(opts, commandContext?.profile);
  const namespace = resolveCollectNamespace(opts, commandContext?.profile);
  const tenantId = opts.tenantId?.trim() || undefined;
  const tenantName = opts.tenantName?.trim() || undefined;
  if (tenantId && tenantName) throw new Error("--tenant-id 与 --tenant-name 不能同时使用");
  const tenantCapability = plugin.tenantConfiguration;
  const tenantOptionsProvided = tenantId
    || tenantName
    || opts.tenantConfigService
    || opts.tenantDirectoryService
    || opts.tenantDirectoryPort;
  if (tenantOptionsProvided && !tenantCapability) {
    throw new Error(`Plugin '${plugin.id}' 未提供租户配置能力`);
  }
  const tenantDirectoryService = tenantCapability
    ? plugin.services.findWith(tenantCapability.directoryService, "tenantDirectory")
    : undefined;
  if (tenantCapability && !tenantDirectoryService) {
    throw new Error(
      `Plugin '${plugin.id}' 的 Service '${tenantCapability.directoryService}' 未声明 tenantDirectory 能力`,
    );
  }
  const tenantDirectoryPort = tenantDirectoryService?.capabilities.tenantDirectory.endpoint.port;
  const tenantConfiguration = tenantCapability && tenantDirectoryService && tenantDirectoryPort !== undefined ? {
    scopes: [...tenantCapability.scopes],
    directoryTarget: {
      service: opts.tenantDirectoryService?.trim() || tenantDirectoryService.name,
      port: parsePort(
        opts.tenantDirectoryPort,
        tenantDirectoryPort,
        "tenant directory port",
      ),
    },
    databaseService: opts.tenantConfigService?.trim() || tenantCapability.databaseService,
  } : undefined;
  return {
    namespace: namespace.namespace,
    namespaceSource: namespace.source,
    services: opts.services === undefined ? [] : parseConfigServices(opts.services, plugin.services),
    servicesExplicit: opts.services !== undefined,
    includeDeploymentConfig: opts.deploymentConfig === true,
    includeDependencies: opts.dependencies === true,
    tenantId,
    tenantName,
    fallbackIdentity,
    tenantConfiguration,
    format,
    outputPath,
    reportName,
    profileName: resolvedProfile.name,
    kube: {
      namespace: namespace.namespace,
      kubeconfig: kubeconfig.kubeconfig,
      context: opts.context,
    },
  };
}

async function promptOptionalCollection(input: {
  title: string;
  warning: string;
  question: string;
}): Promise<boolean | undefined> {
  terminalStdout.write(`[collect] ${input.title}\n`);
  terminalStdout.warning(`[collect] ${input.warning}\n`);
  prepareTerminalInput();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return ["y", "yes"].includes(
      (await readline.question(input.question)).trim().toLowerCase(),
    );
  } catch {
    return undefined;
  } finally {
    readline.close();
  }
}

function promptDeploymentConfigCollection(): Promise<boolean | undefined> {
  return promptOptionalCollection({
    title: "是否采集所选 Service 的 Deployment Env/ConfigMap（Pod 内配置）？",
    warning: "这些配置可能包含密码、密钥等敏感业务数据。",
    question: "采集 Pod 内配置？[y/N] ",
  });
}

function promptDependencyCollection(): Promise<boolean | undefined> {
  return promptOptionalCollection({
    title: "是否进入所选 Service 的业务 Container 采集应用依赖及版本？",
    warning: "依赖清单可能包含内部包名；Doctor 只保存归一化后的包名和版本。",
    question: "采集应用依赖？[y/N] ",
  });
}

export interface ConfigDeploymentSelectionInput {
  config: ConfigCollectConfig;
  interactive?: boolean;
  prompt?: () => Promise<boolean | undefined>;
}

/** CLI flag 视为预先确认；交互终端在 Service 选择后询问，非交互缺省跳过敏感配置。 */
export async function resolveConfigDeploymentSelection(
  input: ConfigDeploymentSelectionInput,
): Promise<boolean | undefined> {
  if (input.config.includeDeploymentConfig) return true;
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  return interactive && await (input.prompt ?? promptDeploymentConfigCollection)();
}

export interface ConfigDependencySelectionInput {
  config: ConfigCollectConfig;
  interactive?: boolean;
  prompt?: () => Promise<boolean | undefined>;
}

/** CLI flag 视为预先确认；非交互缺省不进入业务 Container。 */
export async function resolveConfigDependencySelection(
  input: ConfigDependencySelectionInput,
): Promise<boolean | undefined> {
  if (input.config.includeDependencies) return true;
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  return interactive && await (input.prompt ?? promptDependencyCollection)();
}

export interface ConfigServiceSelectionInput {
  config: ConfigCollectConfig;
  catalog: ServiceCatalog;
  executor: Executor;
  interactive?: boolean;
  recent?: RecentSelections;
  prompt?: (
    choices: readonly ServiceChoice[],
    defaults: readonly string[],
  ) => Promise<string[] | undefined>;
}

/** 显式 flag 直接采用；交互终端从当前 namespace 多选；非交互必须声明目标。 */
export async function resolveConfigServiceSelection(
  input: ConfigServiceSelectionInput,
): Promise<string[] | undefined> {
  if (input.config.servicesExplicit) return input.config.services;
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error("非交互环境必须通过 --services 显式指定要统计的 Service");
  }
  const listed = (await listServiceChoices(input.executor, input.config.namespace))
    .filter((choice) => input.catalog.findWith(choice.name, "config"));
  const recentInput = {
    namespace: input.config.namespace,
    kubeconfig: input.config.kube.kubeconfig,
    context: input.config.kube.context,
    interactive: input.interactive,
    recent: input.recent,
  };
  const choices = rankRecentServiceChoices(listed, recentInput);
  if (!choices.length) {
    throw new Error(`namespace '${input.config.namespace}' 中没有具备配置采集能力的 Service`);
  }
  const selected = await (input.prompt ?? promptNamedChoices)(choices, []);
  if (selected) recordRecentServiceTargets(selected, recentInput);
  return selected;
}

async function promptTenant(
  tenants: readonly TenantSummary[],
  recentChoices: readonly TenantSummary[],
): Promise<TenantPromptChoice | undefined> {
  const choices: TenantPromptChoice[] = [
    { name: "仅部署配置", displayName: "不读取租户配置" },
    ...tenants,
  ];
  return promptTenantChoice({
    choices,
    title: "[collect] 当前启用租户：",
    recentChoices,
  });
}

export interface ConfigTenantSelectionInput {
  config: ConfigCollectConfig;
  directory: TenantDirectory;
  interactive?: boolean;
  recent?: RecentSelections;
  prompt?: (tenants: readonly TenantSummary[]) => Promise<TenantPromptChoice | undefined>;
  log?: (line: string) => void;
}

/** tenant-id 直接采用，tenant-name 走 GetTenant；交互缺省时通过 ListTenant 选择当前启用租户。 */
export async function resolveConfigTenantSelection(
  input: ConfigTenantSelectionInput,
): Promise<ConfigCollectConfig | undefined> {
  if (input.config.tenantId) return input.config;
  if (input.config.tenantName) {
    const tenant = await input.directory.getByName(input.config.tenantName);
    input.log?.(`[collect] tenant: ${tenant.name}（${tenant.id}，--tenant-name）`);
    return { ...input.config, tenantId: tenant.id, tenantName: tenant.name };
  }
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) return input.config;

  let tenants: TenantSummary[];
  try {
    tenants = await input.directory.listActive();
  } catch (error) {
    input.log?.(`[collect] 无法从租户目录列出当前租户，继续仅统计部署配置：${error instanceof Error ? error.message : String(error)}`);
    return input.config;
  }
  if (!tenants.length) {
    input.log?.("[collect] 租户目录未返回启用租户，继续仅统计部署配置");
    return input.config;
  }
  const recent = recentSelectionsForInteractive(input.interactive, input.recent);
  const recentChoices = recent?.recentChoices(
    "tenant",
    input.config.profileName,
    tenants,
    (tenant) => tenant.id,
  ) ?? [];
  const selected = await (input.prompt ?? ((choices) => promptTenant(choices, recentChoices)))(tenants);
  if (!selected) return undefined;
  if (!selected.id) return { ...input.config, tenantName: undefined };
  recent?.recordChoice("tenant", input.config.profileName, selected.id);
  input.log?.(`[collect] tenant: ${selected.name}（${selected.id}）`);
  return { ...input.config, tenantId: selected.id, tenantName: selected.name };
}
