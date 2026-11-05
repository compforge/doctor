import { validateExtension, type Extension, type ExtensionRegistration } from "./index";

export const LOG_WORKLOADS_KIND = "log.workloads";

export interface LogWorkloadsInput {
  /** Absent for explicit Service/time-window collection. */
  readonly bizId?: string;
  readonly since?: string;
  readonly sinceTime?: string;
  readonly untilTime?: string;
}

/**
 * @spec Service owns the static Workload catalog and selects its relevant subset per request.
 * @rule An empty successful result means no collection; lookup failures must throw, never return [].
 * @rule Returned names reference this Service's declarations. Core owns instance discovery and log capture.
 */
export interface LogWorkloadsExtension extends Extension<LogWorkloadsInput, readonly string[]> {
  readonly kind: typeof LOG_WORKLOADS_KIND;
}

export function requireLogWorkloadsExtension(extension: ExtensionRegistration): LogWorkloadsExtension {
  validateExtension(extension);
  if (extension.kind !== LOG_WORKLOADS_KIND) throw new Error(`Expected ${LOG_WORKLOADS_KIND}, got ${extension.kind}`);
  return extension as LogWorkloadsExtension;
}

export function logWorkloadsOutput(value: unknown, declared: readonly { name: string }[]): readonly string[] {
  if (!Array.isArray(value) || value.some(name => typeof name !== "string" || !declared.some(item => item.name === name))) {
    throw new Error("log.workloads must return names declared by its Service");
  }
  return [...new Set(value as string[])];
}

/** Static providers opt into automatic logs without duplicating Workload declarations. */
export function allLogWorkloads(): LogWorkloadsExtension {
  return {
    id: "log-workloads", kind: LOG_WORKLOADS_KIND, access: {},
    run: async context => ({
      data: context.target.service.workloads.map(workload => workload.name),
      summary: { title: "日志 Workload", text: "采集 Service 声明的全部 Workload", fields: [] },
    }),
  };
}
