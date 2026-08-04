import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveProfile } from "../../app/config/config";
import type { ServiceCatalog } from "@compforge/doctor-plugin";
import { resolveCollectKubeconfig, resolveCollectNamespace } from "../../infra/k8s/context";
import type { Executor } from "../../infra/k8s/executor";
import { KubectlPodLogAccess } from "../../infra/k8s/pod-log";
import { parsePodChoices, promptPod } from "../../infra/k8s/pod-selection";
import { listServiceChoices, type ServiceChoice } from "../../infra/k8s/service-selection";
import {
  recentSelectionsForInteractive,
  resolveKubernetesRecentScope,
  type RecentSelections,
} from "../../infra/recent";
import { promptNamedChoices } from "../../terminal/service-selection";
import { terminalStdout } from "../../terminal/output";
import {
  type CollectDataCliOpts,
  type DataConfig,
  type DataOutputFormat,
  type DataServiceSelection,
} from "./model";

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

export function parseDataPodAssignments(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const assignments: Record<string, string> = {};
  for (const item of raw.split(",")) {
    const index = item.indexOf("=");
    const service = item.slice(0, index).trim();
    const pod = item.slice(index + 1).trim();
    if (index <= 0 || !service || !pod) {
      throw new Error(`--pods 只支持 service=pod 形式: '${item.trim()}'`);
    }
    if (assignments[service]) throw new Error(`--pods 重复指定 Service '${service}'`);
    assignments[service] = pod;
  }
  return assignments;
}

export interface DataServiceSelectionInput {
  config: DataConfig;
  catalog: ServiceCatalog;
  executor: Executor;
  interactive?: boolean;
  recent?: RecentSelections;
  promptServices?: (
    choices: readonly ServiceChoice[],
    defaults: readonly string[],
  ) => Promise<string[] | undefined>;
  promptPod?: typeof promptPod;
}

/** Service 先多选；每个 Service 的 Pod 由 selector 候选确认，多候选不静默选择。 */
export async function resolveDataServiceSelection(
  input: DataServiceSelectionInput,
): Promise<DataServiceSelection[] | undefined> {
  const interactive = input.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  const recent = recentSelectionsForInteractive(input.interactive, input.recent);
  const recentScope = resolveKubernetesRecentScope(input.config.kube);
  let selectedInteractively = false;
  let services = input.config.services;
  if (!input.config.services.length) {
    services = input.catalog.servicesWith("data").map((service) => service.name);
  }
  if (interactive && !input.config.servicesExplicit) {
    const listed = (await listServiceChoices(input.executor, input.config.namespace))
      .filter((choice) => input.catalog.findWith(choice.name, "data"));
    const choices = recent
      ? recent.rankServices(recentScope, input.config.namespace, listed)
      : listed;
    if (!choices.length) {
      throw new Error(`namespace '${input.config.namespace}' 中没有已注册数据库检查能力的 Service`);
    }
    const selected = await (input.promptServices ?? promptNamedChoices)(choices, services);
    if (!selected) return undefined;
    services = selected;
    selectedInteractively = true;
  }

  const podAccess = new KubectlPodLogAccess(input.executor, input.config.namespace);
  const listed = await podAccess.listServicePods(services);
  if (!listed.serviceCapture.ok || !listed.podCapture.ok || listed.parseError) {
    const reason = listed.parseError
      ?? (!listed.serviceCapture.ok ? listed.serviceCapture.stderr : listed.podCapture.stderr).trim();
    throw new Error(`读取 Service/Pod 候选失败：${reason || "unknown error"}`);
  }
  const podChoices = parsePodChoices(listed.podCapture.stdout);
  const selections: DataServiceSelection[] = [];
  for (const service of services) {
    const names = listed.byService[service] ?? [];
    const listedChoices = podChoices.filter((pod) => names.includes(pod.name));
    const choices = recent
      ? recent.rankPods(recentScope, input.config.namespace, listedChoices, service)
      : listedChoices;
    const assigned = input.config.podAssignments[service];
    if (assigned) {
      if (!names.includes(assigned)) {
        throw new Error(`Service '${service}' 的 Running Pod 中不存在 '${assigned}'`);
      }
      selections.push({ service, pod: assigned });
      continue;
    }
    if (choices.length === 0) {
      selections.push({ service });
      continue;
    }
    if (choices.length === 1) {
      terminalStdout.write(`[collect] ${service} pod: ${choices[0]!.name}（唯一 Running Pod，自动选择）\n`);
      selections.push({ service, pod: choices[0]!.name });
      continue;
    }
    if (!interactive) {
      throw new Error(
        `Service '${service}' 有 ${choices.length} 个 Running Pod；当前为非交互终端，请用 --pods ${service}=<pod> 指定`,
      );
    }
    const selected = await (input.promptPod ?? promptPod)(choices);
    if (!selected) return undefined;
    selections.push({ service, pod: selected });
    selectedInteractively = true;
  }
  if (selectedInteractively) {
    for (const selection of selections) {
      recent?.recordKubernetesTarget(recentScope, {
        namespace: input.config.namespace,
        service: selection.service,
        pod: selection.pod,
      });
    }
  }
  return selections;
}

export function resolveDataConfig(opts: CollectDataCliOpts, catalog: ServiceCatalog): DataConfig {
  const ids = [...new Set(opts.ids.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) throw new Error("doctor data 至少需要一个 biz id");
  const format = parseDataOutputFormat(opts.format);
  if (format === "json" && opts.output) throw new Error("--output 仅在 --format html 时可用");
  const reportName = dataReportName(new Date());
  const outputPath = format === "html" ? resolveDataHtmlOutputPath(opts.output, reportName) : undefined;
  const configPath = opts.config ?? process.env.DOCTOR_CONFIG ?? join(homedir(), ".doctor", "config.yaml");
  const resolvedProfile = resolveProfile(loadConfig(configPath), opts.profile);
  const profile = resolvedProfile.profile;
  const fallbackIdentity = profile.db?.user && profile.db.password
    ? { user: profile.db.user, password: profile.db.password }
    : undefined;
  const kubeconfig = resolveCollectKubeconfig(opts);
  const namespace = resolveCollectNamespace(opts);
  const services = parseDataServices(opts.services, catalog);
  const podAssignments = parseDataPodAssignments(opts.pods);
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
    podAssignments,
    kube: {
      namespace: namespace.namespace,
      kubeconfig: kubeconfig.kubeconfig,
      context: opts.context,
    },
  };
}
