import type { Extension, RegisteredExtension } from "./index";
import type { ServiceMetricCapability } from "../service";

export const METRIC_CONFIGURATION_KIND = "metric.configuration";

/** Scraping and PromQL evaluation belong to the consumer of this configuration. */
export type MetricConfiguration = ServiceMetricCapability;
export interface MetricConfigurationExtension extends Extension<void, MetricConfiguration> {
  readonly kind: typeof METRIC_CONFIGURATION_KIND;
}

export function requireMetricConfigurationExtension(extension: RegisteredExtension): MetricConfigurationExtension {
  if (extension.kind !== METRIC_CONFIGURATION_KIND) throw new Error(`Expected ${METRIC_CONFIGURATION_KIND}, got ${extension.kind}`);
  return extension as MetricConfigurationExtension;
}

export function metricConfigurationOutput(value: unknown): MetricConfiguration {
  const config = value as MetricConfiguration | undefined;
  const endpoint = config?.endpoint;
  if (!config || !endpoint || typeof endpoint.host !== "string" || !endpoint.host.trim()
    || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535
    || typeof endpoint.path !== "string" || !endpoint.path.startsWith("/")
    || !Array.isArray(config.metricNames) || config.metricNames.some(name => typeof name !== "string" || !name.trim())
    || !Array.isArray(config.charts) || (config.detectors !== undefined && !Array.isArray(config.detectors))) {
    throw new Error("metric.configuration returned an invalid configuration");
  }
  for (const item of [...config.charts, ...(config.detectors ?? [])]) {
    if (!item || typeof item.id !== "string" || !item.id.trim()
      || typeof item.title !== "string" || !item.query
      || typeof item.query.instant !== "string" || typeof item.query.range !== "string") {
      throw new Error("metric.configuration returned an invalid query");
    }
  }
  for (const chart of config.charts) {
    if (!["line", "pie"].includes(chart.kind) || typeof chart.description !== "string"
      || (chart.unit !== undefined && !["seconds", "percent", "count"].includes(chart.unit))
      || (chart.label !== undefined && typeof chart.label !== "string")) {
      throw new Error("metric.configuration returned an invalid chart");
    }
  }
  for (const detector of config.detectors ?? []) {
    if (detector.operator !== "gt" || !Number.isFinite(detector.threshold)
      || !["warning", "critical"].includes(detector.severity) || typeof detector.message !== "string") {
      throw new Error("metric.configuration returned an invalid detector");
    }
  }
  return config;
}
