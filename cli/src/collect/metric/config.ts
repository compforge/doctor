import { join } from "node:path";
import type { ServiceCatalog } from "@compforge/doctor-plugin";
import { resolveCollectNamespace } from "../../infra/k8s/context";
import { resolveKubernetesCommandConfig } from "../../command/kubernetes-target";
import { matchListedChoice, printNumberedChoices, promptListedChoice } from "../../terminal/selection";
import type { CollectMetricCliOpts, MetricConfig, MetricOutputFormat, MetricWatch } from "./model";
import type { CommandContext } from "../../command";
import { resolveArchivePath } from "../output/archive";

export function parseMetricOutputFormat(raw: string | undefined): MetricOutputFormat {
  const format = raw?.trim() || "default";
  if (format !== "default" && format !== "bundle" && format !== "html") {
    throw new Error(`--format 只支持 bundle 或 html: '${format}'`);
  }
  return format;
}

const WATCH_CHOICES: readonly MetricWatch[] = [
  { mode: "snapshot", label: "0" },
  { mode: "duration", label: "1m", durationMs: 60_000 },
  { mode: "duration", label: "2m", durationMs: 120_000 },
  { mode: "duration", label: "5m", durationMs: 300_000 },
  { mode: "duration", label: "10m", durationMs: 600_000 },
  { mode: "until-interrupt", label: "Ctrl+C" },
];

export function parseMetricWatch(raw: string | undefined): MetricWatch {
  const value = raw?.trim().toLowerCase() || "0";
  const found = WATCH_CHOICES.find((choice) => (
    choice.label.toLowerCase() === value
    || (choice.mode === "until-interrupt" && ["ctrl+c", "interrupt", "until-interrupt"].includes(value))
  ));
  if (!found) throw new Error("--watch 只支持 0、1m、2m、5m、10m 或 until-interrupt");
  return found;
}

export async function resolveMetricWatch(raw: string | undefined, interactive: boolean): Promise<MetricWatch | undefined> {
  if (raw !== undefined || !interactive) return parseMetricWatch(raw);
  printNumberedChoices(WATCH_CHOICES, "Metric 采集窗口：", (choice) => (
    choice.mode === "snapshot" ? "0（读取启动至今的累计快照）"
      : choice.mode === "until-interrupt" ? "Ctrl+C（持续采集，手动中断后生成报告）"
        : choice.label
  ));
  return promptListedChoice({
    question: "选择 watch 窗口（序号/名称，回车默认 0，q 取消）: ",
    match: (answer) => matchListedChoice(
      WATCH_CHOICES,
      answer,
      (choice) => choice.label,
      (choice) => choice,
    ),
    invalidMessage: "请选择 0、1m、2m、5m、10m 或 Ctrl+C",
    emptyValue: WATCH_CHOICES[0],
  });
}

export function parseMetricInterval(raw: string | undefined): number {
  const value = raw?.trim().toLowerCase() || "5s";
  const match = /^(\d+)(ms|s)$/.exec(value);
  if (!match) throw new Error("--interval 只支持毫秒或秒，例如 500ms、5s");
  const intervalMs = Number(match[1]) * (match[2] === "s" ? 1000 : 1);
  if (intervalMs < 500 || intervalMs > 60_000) throw new Error("--interval 必须在 500ms..60s 之间");
  return intervalMs;
}

export function parseMetricServices(raw: string | undefined, catalog: ServiceCatalog): string[] {
  const defaults = catalog.servicesWith("metric").map((service) => service.name);
  const services = [...new Set((raw ?? defaults.join(",")).split(",").map((item) => item.trim()).filter(Boolean))];
  if (!services.length) throw new Error("--services 未解析出任何 Service");
  const unsupported = services.filter((service) => !catalog.findWith(service, "metric"));
  if (unsupported.length) throw new Error(`Doctor 未注册以下 Service 的 metric capability：${unsupported.join(", ")}`);
  return services;
}

export async function resolveMetricConfig(
  opts: CollectMetricCliOpts,
  catalog: ServiceCatalog,
  commandContext: CommandContext,
  interactive = !!(process.stdin.isTTY && process.stdout.isTTY),
): Promise<MetricConfig | undefined> {
  const resolvedProfile = {
    name: commandContext.profile.name,
    profile: commandContext.profile.value,
  };
  const watch = await resolveMetricWatch(opts.watch, interactive);
  if (!watch) return undefined;
  let namespace = resolveCollectNamespace(opts, commandContext.profile);
  const reportName = metricReportName(new Date());
  const format = parseMetricOutputFormat(opts.format);
  if (format === "bundle" && /\.(?:html|md)$/i.test(opts.output ?? "")) {
    throw new Error("--format bundle 的输出路径不能使用 .html/.md 后缀");
  }
  const prometheusUrl = opts.prometheus?.trim() || resolvedProfile.profile.prometheus?.url?.trim();
  const configuredPrometheus = resolvedProfile.profile.prometheus;
  const services = parseMetricServices(opts.services, catalog);
  const hasStoreMetrics = services.some((service) => (
    catalog.findWith(service, "stores")?.capabilities.stores.some((store) => (
      store.kind === "redis" || (store.kind === "db" && store.backend === "mysql")
    ))
  ));
  let kubeconfig: string | undefined;
  let kubeContext = opts.context;
  let profileName = resolvedProfile.name;
  let storeSupplementUnavailableReason: string | undefined;
  if (!prometheusUrl || hasStoreMetrics) {
    try {
      const collect = await resolveKubernetesCommandConfig(opts, undefined, commandContext);
      if (!collect) {
        if (!prometheusUrl) return undefined;
        storeSupplementUnavailableReason = "Kubernetes target selection cancelled";
      } else {
        profileName = collect.profileName;
        namespace = {
          namespace: collect.kubernetes.namespace,
          source: collect.kubernetes.namespaceSource,
        };
        kubeconfig = collect.kubernetes.kubeconfig;
        kubeContext = collect.kubernetes.context;
      }
    } catch (error) {
      if (!prometheusUrl) throw error;
      // Remote Prometheus is the primary source. A missing Kubernetes channel only disables
      // the optional live Store supplement; Store probes can still query exporter metrics remotely.
      storeSupplementUnavailableReason = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    services,
    servicesExplicit: opts.services !== undefined,
    watch,
    intervalMs: parseMetricInterval(opts.interval),
    profileName,
    prometheus: prometheusUrl ? {
      url: prometheusUrl,
      username: configuredPrometheus?.username,
      password: configuredPrometheus?.password,
      timeoutMs: configuredPrometheus?.timeout_ms ?? 10_000,
      maxResponseBytes: configuredPrometheus?.max_response_bytes ?? 4 * 1024 * 1024,
    } : undefined,
    storeSupplementUnavailableReason,
    namespace: namespace.namespace,
    namespaceSource: namespace.source,
    kube: {
      namespace: namespace.namespace,
      kubeconfig,
      context: kubeContext,
    },
    reportName,
    format,
    outputPath: format === "bundle"
      ? resolveArchivePath(opts.output, reportName)
      : resolveMetricOutputPath(opts.output, reportName),
  };
}

export function metricReportName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `doctor-metric-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function resolveMetricOutputPath(output: string | undefined, reportName: string): string {
  if (!output) return join(".", `${reportName}.html`);
  return output.toLowerCase().endsWith(".html") ? output : `${output}.html`;
}
