import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveProfile } from "../../app/config/config";
import type { ServiceCatalog } from "@compforge/doctor-plugin";
import { resolveCollectKubeconfig, resolveCollectNamespace } from "../../infra/k8s/context";
import type { ServiceChoice } from "../../infra/k8s/service-selection";
import {
  promptNamedChoices,
  type NamedChoiceSelectionInput,
} from "../../terminal/service-selection";
import {
  type CollectDataCliOpts,
  type DataConfig,
  type DataOutputFormat,
  type DataServiceSelection,
} from "./model";
import type { CommandContext } from "../../command";

export function parseDataOutputFormat(value: string | undefined): DataOutputFormat {
  const format = value?.trim() || "json";
  if (format !== "json" && format !== "html") {
    throw new Error(`--format 只支持 json 或 html: '${format}'`);
  }
  return format;
}

export function resolveDataHtmlOutputPath(output: string | undefined, reportName: string): string {
  if (!output) return join(".", `${reportName}.html`);
  if (/\.(?:tar\.gz|tgz)$/i.test(output)) {
    throw new Error("--format html 的输出路径不能使用 .tar.gz/.tgz 后缀");
  }
  return output.toLowerCase().endsWith(".html") ? output : `${output}.html`;
}

export function dataReportName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `doctor-data-${timestamp}`;
}

export function parseDataServices(raw: string | undefined, catalog: ServiceCatalog): string[] {
  const defaults = catalog.servicesWith("data").map((service) => service.name);
  const values = (raw ?? defaults.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const services = [...new Set(values)];
  if (!services.length) throw new Error("--services 未解析出任何 Service");
  const unsupported = services.filter((service) => !catalog.findWith(service, "data"));
  if (unsupported.length) {
    throw new Error(`Doctor 未注册以下 Service 的数据贡献能力：${unsupported.join(", ")}`);
  }
  return services;
}

export interface DataServiceSelectionInput {
  config: DataConfig;
  catalog: ServiceCatalog;
  interactive?: boolean;
  promptServices?: (input: NamedChoiceSelectionInput<ServiceChoice>) => Promise<string[] | undefined>;
}

/** Core 只选择 capability provider；Service 是否可用以及如何访问由 Plugin 判断。 */
export async function resolveDataServiceSelection(
  input: DataServiceSelectionInput,
): Promise<DataServiceSelection[] | undefined> {
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  let services = input.config.services;
  if (!input.config.services.length) {
    services = input.catalog.servicesWith("data").map((service) => service.name);
  }
  if (interactive && !input.config.servicesExplicit) {
    const choices = input.catalog.servicesWith("data").map((service) => ({ name: service.name }));
    if (!choices.length) {
      throw new Error("当前 Plugin 未声明 data capability");
    }
    const selected = await (input.promptServices ?? promptNamedChoices)({
      choices,
      defaults: services,
      candidateType: "Service",
      context: { purpose: "确定业务数据读取范围" },
    });
    if (!selected) return undefined;
    services = selected;
  }
  return services.map((service) => ({ service }));
}

export function resolveDataConfig(
  opts: CollectDataCliOpts,
  catalog: ServiceCatalog,
  commandContext?: CommandContext,
): DataConfig {
  const ids = [...new Set([
    ...(opts.bizIds ?? []),
    ...(opts.bizId ? [opts.bizId] : []),
  ].map((bizId) => bizId.trim()).filter(Boolean))];
  if (!ids.length) throw new Error("doctor data 需要至少一个 biz-id");
  const format = parseDataOutputFormat(opts.format);
  if (format === "json" && opts.output) throw new Error("--output 仅在 --format html 时可用");
  const reportName = opts.reportName ?? dataReportName(new Date());
  const outputPath = format === "html" ? resolveDataHtmlOutputPath(opts.output, reportName) : undefined;
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
  const services = parseDataServices(opts.services, catalog);
  return {
    ids,
    format,
    outputPath,
    reportName,
    profileName: resolvedProfile.name,
    fallbackIdentity,
    namespace: namespace.namespace,
    namespaceSource: namespace.source,
    services,
    servicesExplicit: opts.services !== undefined,
    kube: {
      namespace: namespace.namespace,
      kubeconfig: kubeconfig.kubeconfig,
      context: opts.context,
    },
  };
}
