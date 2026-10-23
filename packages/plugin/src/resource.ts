import type { Resource, ResourceSnapshot, ServiceResource } from "@compforge/harness-common";
import type { JsonObject } from "./json";
import { validateOperation, type PluginOperation } from "./operation";

export type { Resource, ResourceCoverage, ResourceInstance, ResourceInstanceRef, ResourceMeasurement,
  ResourceSnapshot, ServiceResource } from "@compforge/harness-common";

export interface ResourceQuery {
  readonly maxInstances: number;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  /** Opaque continuation for exactly one Service/resource; no implicit full scan. */
  readonly cursor?: string;
}

/**
 * Service owns the association; Common owns the resource identity and snapshot.
 * @spec observe is a read-only native operation, not an Extension. Catalog discovery never invokes it.
 * @rule Use context.target.env for snapshot identity; honor signal and budgets at the source.
 * @link cli/docs/commands/resource.md
 */
export interface ServiceResourceDefinition extends Omit<ServiceResource, "service"> {
  readonly observe: PluginOperation<ResourceQuery, ResourceSnapshot<JsonObject>>;
}

function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Resource ${label} must be non-empty`);
}
function resource(value: Resource): void {
  if (!value) throw new Error("Resource declaration is required");
  for (const key of ["id", "kind", "name"] as const) nonempty(value[key], key);
  if (value.description !== undefined && typeof value.description !== "string") throw new Error("Invalid Resource description");
}
export function validateServiceResource(value: ServiceResourceDefinition): void {
  resource(value?.resource);
  if (!["manages", "uses"].includes(value.relationship)) throw new Error("Invalid Resource relationship");
  validateOperation(value.observe);
}

/** Validate external Plugin evidence before serialization; unknown counts remain absent. */
export function validateResourceSnapshot(value: ResourceSnapshot<JsonObject>, expected: { resource: Resource; environment: string }, query: ResourceQuery): void {
  resource(value?.resource);
  if (value.resource.id !== expected.resource.id || value.resource.kind !== expected.resource.kind
    || value.environment !== expected.environment) throw new Error("Resource snapshot identity does not match its request");
  nonempty(value.source, "source");
  nonempty(value.observedAt, "observedAt");
  if (!Number.isFinite(Date.parse(value.observedAt))) throw new Error("Invalid Resource observedAt");
  if (!value.scope || typeof value.scope !== "object" || Array.isArray(value.scope)
    || Object.values(value.scope).some(v => typeof v !== "string")) throw new Error("Invalid Resource scope");
  if (!value.coverage || !["complete", "partial", "unavailable"].includes(value.coverage.status)) throw new Error("Invalid Resource coverage");
  if (value.coverage.status !== "complete") nonempty(value.coverage.reason, "coverage reason");
  if (value.totalCount !== undefined && (!Number.isSafeInteger(value.totalCount) || value.totalCount < 0)) throw new Error("Invalid Resource totalCount");
  if (value.instances !== undefined && (!Array.isArray(value.instances) || value.instances.length > query.maxInstances)) throw new Error("Resource instance budget exceeded");
  const identities = new Set<string>();
  for (const instance of value.instances ?? []) {
    nonempty(instance?.ref?.id, "instance id");
    if (instance.ref.environment !== value.environment || instance.ref.resource !== value.resource.id
      || identities.has(instance.ref.id)) throw new Error("Invalid or duplicate Resource instance identity");
    identities.add(instance.ref.id);
    for (const field of [instance.name, instance.state]) if (field !== undefined && typeof field !== "string") throw new Error("Invalid Resource instance label");
  }
  if (value.totalCount !== undefined && value.totalCount < identities.size) throw new Error("Resource totalCount is smaller than the observed page");
  if (value.measurements !== undefined && !Array.isArray(value.measurements)) throw new Error("Invalid Resource measurements");
  for (const measurement of value.measurements ?? []) {
    nonempty(measurement?.name, "measurement name"); nonempty(measurement.unit, "measurement unit");
    if (typeof measurement.value !== "number" || !Number.isFinite(measurement.value)
      || !["observed", "total"].includes(measurement.scope)) throw new Error("Invalid Resource measurement");
  }
  if (value.nextCursor !== undefined) {
    nonempty(value.nextCursor, "nextCursor");
    if (value.coverage.status !== "partial") throw new Error("Resource continuation requires partial coverage");
  }
  const json = JSON.stringify(value, (_key, entry) => {
    if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint"
      || entry instanceof Map || entry instanceof Set || typeof entry === "number" && !Number.isFinite(entry)) throw new Error("Resource snapshot must be JSON evidence");
    return entry;
  });
  if (new TextEncoder().encode(json).byteLength > query.maxBytes) throw new Error("Resource snapshot byte budget exceeded");
}
