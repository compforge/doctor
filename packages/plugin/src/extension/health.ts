import { immutableJsonObject, type JsonObject, type DataSource, type Client } from "@compforge/harness-common";
import type { PluginContext } from "../context";
import { validateCaseRef, type ServiceCaseRef } from "../cases";
import { validateExtension, type Extension, type ExtensionRegistration } from "./index";

export const HEALTH_SCOPES = ["infra", "self", "deps", "biz"] as const;
export type HealthScope = typeof HEALTH_SCOPES[number];
export type HealthCheckKind = `healthcheck.${HealthScope}`;
export const HEALTH_CHECK_KINDS = HEALTH_SCOPES.map(scope => `healthcheck.${scope}` as HealthCheckKind);

/** Health owns which shared Case source must be reachable from its Service's Workload. */
export interface HealthCaseBinding {
  readonly id: string;
  readonly workload: string;
  readonly producer: ServiceCaseRef;
  /** Services that forward the producer's request material, in delivery order. */
  readonly via?: readonly string[];
}

export interface HealthCheckQuery { readonly tenantId?: string; readonly bizId?: string; readonly pod?: string; readonly container?: string }
export interface HealthCaseBindingsResult { readonly bindings: readonly HealthCaseBinding[] }


export interface HealthProbeResult {
  status: "passed" | "failed" | "partial" | "unavailable" | "cancelled";
  summary: string;
  /** Bounded, credential-free evidence; the provider owns its meaning. */
  evidence?: JsonObject;
}
export interface HealthProbeInput<C extends Client = Client> extends HealthCheckQuery {
  checkpoint(result: HealthProbeResult): void;
  /** Initialized only after approving this resolved source's check. */
  client?: () => Promise<C>;
}
export interface HealthProbeExtension<C extends Client = Client> extends Extension<HealthProbeInput<C>, HealthProbeResult> {
  kind: HealthCheckKind;
  execution: "probe";
  description: string;
  /**
   * @spec Resolve configuration only, without connecting to or probing the target.
   * Core authorizes discovery once, then reuses identical source/probe/parameter results within this Health session.
   * The returned source lives inside this invocation; Core disposes its clients before closing the Plugin context.
   */
  dataSource?(context: PluginContext, query: HealthCheckQuery): Promise<DataSource<C>>;
  /** Stable probe implementation/version; required for DataSource-backed checks. */
  probe?: string;
  /** Inputs and verdict policy that distinguish checks of the same source. */
  parameters?: JsonObject;
  /** Displayed before probe execution; standalone probes also approve configuration access here. */
  approval: { risk: "observe" | "disrupt"; target: string; impact: readonly string[] };
}
export interface HealthCaseExtension extends Extension<HealthCheckQuery, HealthCaseBindingsResult> {
  kind: HealthCheckKind;
  execution: "cases";
  description: string;
}
/**
 * @spec Each Service contributes explicit checks; the kind is the sole scope declaration.
 * @spec Probe providers own targets, sampling and verdicts. Case providers own consumption bindings and expectations.
 * @spec Core owns scheduling, approval, cancellation and evidence delivery, never implicit DataSource checks.
 */
export type HealthCheckExtension = HealthProbeExtension | HealthCaseExtension;

export function healthCheckScope(extension: Pick<HealthCheckExtension, "kind">): HealthScope {
  if (!HEALTH_CHECK_KINDS.includes(extension.kind)) throw new Error(`Unsupported healthcheck kind: ${extension.kind}`);
  return extension.kind.slice("healthcheck.".length) as HealthScope;
}
export function requireHealthCheckExtension(extension: ExtensionRegistration): HealthCheckExtension {
  validateExtension(extension);
  const check = extension as HealthCheckExtension;
  healthCheckScope(check);
  if (!check.description?.trim()) throw new Error(`${check.id}: HealthCheck description is required`);
  if (check.execution !== "probe" && check.execution !== "cases") throw new Error(`${extension.id}: HealthCheck execution must be probe or cases`);
  if (check.execution === "probe" && (!check.approval || !["observe", "disrupt"].includes(check.approval.risk)
    || !check.approval.target?.trim() || !Array.isArray(check.approval.impact) || check.approval.impact.some(line => typeof line !== "string"))) {
    throw new Error(`${check.id}: HealthCheck approval must declare risk, target and impact`);
  }
  if (check.execution === "probe" && check.dataSource !== undefined) {
    if (typeof check.dataSource !== "function" || !check.probe?.trim()) throw new Error(`${check.id}: DataSource checks require a resolver and probe identifier`);
    if (check.parameters !== undefined) immutableJsonObject(check.parameters, "HealthCheck parameters");
  }
  return check;
}
export function requireHealthCaseExtension(extension: ExtensionRegistration): HealthCaseExtension {
  const check = requireHealthCheckExtension(extension);
  if (check.execution !== "cases") throw new Error(`${check.id}: Expected a Case HealthCheck`);
  return check;
}
export function validateHealthProbeResult(value: HealthProbeResult): void {
  if (!value || !["passed", "failed", "partial", "unavailable", "cancelled"].includes(value.status) || typeof value.summary !== "string" || !value.summary.trim()) {
    throw new Error("HealthCheck must return status and a nonempty summary");
  }
  if (value.evidence !== undefined) immutableJsonObject(value.evidence, "HealthCheck evidence");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 128 * 1024) throw new Error("HealthCheck result exceeds 128 KiB");
}

export function validateHealthCaseBindingsResult(value: HealthCaseBindingsResult): void {
  if (!value || typeof value !== "object") throw new Error("Case HealthCheck must return bindings");
  validateHealthCaseBindings(value.bindings);
}

export function validateHealthCaseBindings(bindings: readonly HealthCaseBinding[]): void {
  if (!Array.isArray(bindings)) throw new Error("Case bindings must be an array");
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (!binding || typeof binding.id !== "string" || !binding.id.trim()) throw new Error("Case binding id must be non-empty");
    if (typeof binding.workload !== "string" || !binding.workload.trim()) throw new Error("Case binding workload must be non-empty");
    if (ids.has(binding.id)) throw new Error(`Duplicate Case binding: ${binding.id}`);
    ids.add(binding.id);
    validateCaseRef(binding.producer);
    if (binding.via !== undefined && (!Array.isArray(binding.via)
      || binding.via.some((service: unknown) => typeof service !== "string" || !service.trim()))) {
      throw new Error("Case binding via must contain canonical Service names");
    }
  }
}
