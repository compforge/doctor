import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { ServiceCatalog } from "@compforge/doctor-plugin";
import type { PluginDefinition } from "@compforge/doctor-plugin";
import type { Executor } from "../../infra/k8s/executor";
import { resolveKubernetesCommandConfig } from "../../command/kubernetes-target";
import {
  rankRecentServiceChoices,
  recordRecentServiceTargets,
  type ServiceChoice,
} from "../../infra/k8s/service-selection";
import type { RecentSelections } from "../../infra/recent";
import {
  promptNamedChoices,
  type NamedChoiceSelectionInput,
} from "../../terminal/service-selection";
import { prepareTerminalInput } from "../../terminal/input";
import { terminalStdout } from "../../terminal/output";
import type {
  CollectInspectCliOpts,
  InspectConfig,
  InspectOutputFormat,
} from "./model";
import type { CommandContext } from "../../command";
import { resolveArchivePath, resolveDefaultReportPaths } from "../output/archive";

export function parseInspectServices(raw: string, catalog: ServiceCatalog): string[] {
  const services = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
  if (!services.length) throw new Error("--services 未解析出任何 Service");
  const unsupported = services.filter((service) => !catalog.find(service));
  if (unsupported.length) {
    throw new Error(`Doctor Plugin 未注册以下 Service：${unsupported.join(", ")}`);
  }
  return services;
}

export function parseInspectOutputFormat(value: string | undefined): InspectOutputFormat {
  const format = value?.trim() || "default";
  if (format !== "default" && format !== "bundle" && format !== "json" && format !== "html" && format !== "md") {
    throw new Error(`--format 只支持 bundle、json、html 或 md: '${format}'`);
  }
  return format;
}

export function inspectReportName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `doctor-inspect-${timestamp}`;
}

export function resolveInspectHtmlOutputPath(output: string | undefined, reportName: string): string {
  if (!output) return join(".", `${reportName}.html`);
  if (/\.(?:tar\.gz|tgz)$/i.test(output)) {
    throw new Error("--format html 的输出路径不能使用 .tar.gz/.tgz 后缀");
  }
  return output.toLowerCase().endsWith(".html") ? output : `${output}.html`;
}

export function resolveInspectMarkdownOutputPath(output: string | undefined, reportName: string): string {
  if (!output) return join(".", `${reportName}.md`);
  if (/\.(?:tar\.gz|tgz|html)$/i.test(output)) {
    throw new Error("--format md 的输出路径不能使用 .tar.gz/.tgz/.html 后缀");
  }
  return output.toLowerCase().endsWith(".md") ? output : `${output}.md`;
}

export async function resolveInspectConfig(
  opts: CollectInspectCliOpts,
  plugin: PluginDefinition,
  commandContext: CommandContext,
  executor?: Executor,
): Promise<InspectConfig | undefined> {
  const format = parseInspectOutputFormat(opts.format);
  if (format === "json" && opts.output) throw new Error("--output 仅在 --format html 或 md 时可用");
  const reportName = inspectReportName(new Date());
  const outputPath = format === "default"
    ? resolveDefaultReportPaths(opts.output, reportName).html
    : format === "html"
      ? resolveInspectHtmlOutputPath(opts.output, reportName)
      : format === "md"
        ? resolveInspectMarkdownOutputPath(opts.output, reportName)
        : format === "bundle"
          ? resolveArchivePath(opts.output, reportName)
          : undefined;
  const collect = await resolveKubernetesCommandConfig(opts, executor, commandContext);
  if (!collect) return undefined;
  return {
    namespace: collect.kubernetes.namespace,
    namespaceSource: collect.kubernetes.namespaceSource,
    services: opts.services === undefined ? [] : parseInspectServices(opts.services, plugin.services),
    servicesExplicit: opts.services !== undefined,
    includeDeploymentConfig: opts.deploymentConfig === true,
    includeDependencies: opts.dependencies === true,
    format,
    outputPath,
    reportName,
    profileName: collect.profileName,
    kube: {
      namespace: collect.kubernetes.namespace,
      kubeconfig: collect.kubernetes.kubeconfig,
      context: collect.kubernetes.context,
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

export interface InspectDeploymentSelectionInput {
  config: InspectConfig;
  interactive?: boolean;
  prompt?: () => Promise<boolean | undefined>;
}

/** CLI flag 视为预先确认；交互终端在 Service 选择后询问，非交互缺省跳过敏感配置。 */
export async function resolveInspectDeploymentSelection(
  input: InspectDeploymentSelectionInput,
): Promise<boolean | undefined> {
  if (input.config.includeDeploymentConfig) return true;
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  return interactive && await (input.prompt ?? promptDeploymentConfigCollection)();
}

export interface InspectDependencySelectionInput {
  config: InspectConfig;
  interactive?: boolean;
  prompt?: () => Promise<boolean | undefined>;
}

/** CLI flag 视为预先确认；非交互缺省不进入业务 Container。 */
export async function resolveInspectDependencySelection(
  input: InspectDependencySelectionInput,
): Promise<boolean | undefined> {
  if (input.config.includeDependencies) return true;
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  return interactive && await (input.prompt ?? promptDependencyCollection)();
}

export interface InspectServiceSelectionInput {
  config: InspectConfig;
  catalog: ServiceCatalog;
  executor: Executor;
  interactive?: boolean;
  recent?: RecentSelections;
  prompt?: (input: NamedChoiceSelectionInput<ServiceChoice>) => Promise<string[] | undefined>;
}

/** 显式 flag 直接采用；交互终端从当前 namespace 多选；非交互必须声明目标。 */
export async function resolveInspectServiceSelection(
  input: InspectServiceSelectionInput,
): Promise<string[] | undefined> {
  if (input.config.servicesExplicit) return input.config.services;
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error("非交互环境必须通过 --services 显式指定要统计的 Service");
  }
  const listed = input.catalog.services
    .filter((service) => service.workloads.length > 0)
    .map((service) => ({ name: service.name }));
  const recentInput = {
    namespace: input.config.namespace,
    kubeconfig: input.config.kube.kubeconfig,
    context: input.config.kube.context,
    interactive: input.interactive,
    recent: input.recent,
  };
  const choices = rankRecentServiceChoices(listed, recentInput);
  if (!choices.length) {
    throw new Error("当前 Plugin 没有声明可 Inspect 的 Service Workload");
  }
  const selected = await (input.prompt ?? promptNamedChoices)({
    choices,
    defaults: [],
    candidateType: "Service",
    context: { purpose: "确定 Service Inspect 范围" },
  });
  if (selected) recordRecentServiceTargets(selected, recentInput);
  return selected;
}
