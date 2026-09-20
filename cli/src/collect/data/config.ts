import { dataProviders, findDataProvider } from "./extensions";
import { isInteractive } from "../../terminal/policy";
import { join } from "node:path";
import type { ServiceCatalog } from "@compforge/doctor-plugin";
import {
  resolveKubernetesCommandConfig,
} from "../../command/kubernetes-target";
import type { Executor } from "@compforge/harness-toolbox/kubernetes/executor";
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
import { resolveArchivePath, resolveDefaultReportPaths } from "../output/archive";

export function parseDataOutputFormat(value: string | undefined): DataOutputFormat {
  const format = value?.trim() || "default";
  if (format !== "default" && format !== "bundle" && format !== "json" && format !== "html" && format !== "summary") {
    throw new Error(`--format 只支持 bundle、json、html 或 summary: '${format}'`);
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

export function resolveDataJsonOutputPath(output: string | undefined, reportName: string): string {
  if (!output) return join(".", `${reportName}.json`);
  return output.toLowerCase().endsWith(".json") ? output : `${output}.json`;
}

export function dataReportName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `doctor-data-${timestamp}`;
}

/** Providers reachable from a biz_id Query through declared Relation expansions. */
export function dataServicesForBizQuery(catalog: ServiceCatalog): string[] {
  const providers = dataProviders(catalog);
  const reachable = new Set(["biz_id"]);
  const selected = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const service of providers) {
      const capability = service.extension;
      if (!capability.accepts.some((kind) => reachable.has(kind))) continue;
      if (!selected.has(service.name)) {
        selected.add(service.name);
        changed = true;
      }
      for (const kind of capability.expands ?? []) {
        if (reachable.has(kind)) continue;
        reachable.add(kind);
        changed = true;
      }
    }
  }
  return providers
    .map((service) => service.name)
    .filter((service) => selected.has(service));
}

export function parseDataServices(raw: string | undefined, catalog: ServiceCatalog): string[] {
  const values = (raw ?? dataServicesForBizQuery(catalog).join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const services = [...new Set(values)];
  if (!services.length) throw new Error("--services 未解析出任何 Service");
  const unsupported = services.filter((service) => !findDataProvider(catalog, service));
  if (unsupported.length) {
    throw new Error(`Doctor 未注册以下 Service 的 facts.inspect Extension：${unsupported.join(", ")}`);
  }
  return catalog.resolveNames(services);
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
  const interactive = isInteractive(input.interactive);
  let services = input.config.services;
  if (!input.config.services.length) {
    services = dataServicesForBizQuery(input.catalog);
  }
  if (interactive && !input.config.servicesExplicit) {
    const choices = dataServicesForBizQuery(input.catalog).map((name) => ({ name }));
    if (!choices.length) {
      throw new Error("当前 Plugin 未声明 facts.inspect Extension");
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

export async function resolveDataConfig(
  opts: CollectDataCliOpts,
  catalog: ServiceCatalog,
  commandContext: CommandContext,
  executor?: Executor,
): Promise<DataConfig | undefined> {
  const ids = [...new Set([
    ...(opts.bizIds ?? []),
  ].map((bizId) => bizId.trim()).filter(Boolean))];
  if (!ids.length) throw new Error("doctor data 需要至少一个 biz-id");
  const format = parseDataOutputFormat(opts.format);
  if (format === "summary" && opts.output) throw new Error("--format summary 直接输出到终端，不支持 --output");
  const reportName = dataReportName(new Date());
  const outputPath = format === "default"
    ? resolveDefaultReportPaths(opts.output, reportName).html
    : format === "html"
      ? resolveDataHtmlOutputPath(opts.output, reportName)
      : format === "bundle"
        ? resolveArchivePath(opts.output, reportName)
        : format === "json"
          ? resolveDataJsonOutputPath(opts.output, reportName)
          : undefined;
  const resolvedProfile = {
    name: commandContext.profile.name,
    profile: commandContext.profile.value,
  };
  const profile = resolvedProfile.profile;
  const fallbackIdentity = profile.db?.user && profile.db.password
    ? { user: profile.db.user, password: profile.db.password }
    : undefined;
  const collect = await resolveKubernetesCommandConfig(opts, executor, commandContext);
  if (!collect) return undefined;
  const services = parseDataServices(opts.services, catalog);
  return {
    ids,
    format,
    outputPath,
    reportName,
    profileName: collect.profileName,
    fallbackIdentity,
    namespace: collect.kubernetes.namespace,
    namespaceSource: collect.kubernetes.namespaceSource,
    services,
    servicesExplicit: opts.services !== undefined,
    kube: {
      namespace: collect.kubernetes.namespace,
      kubeconfig: collect.kubernetes.kubeconfig,
      context: collect.kubernetes.context,
    },
  };
}
