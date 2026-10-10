import type { ServiceInspectBudget, ServiceInspectSource } from "@compforge/doctor-plugin";

/** Validate acquisition metadata independently from opaque domain Facts. */
export function normalizeInspectSources(value: unknown, service: string): ServiceInspectSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${service} inspect sources must be an array`);
  return value.map((item, index) => {
    const label = `${service} inspect sources[${index}]`;
    if (!item || typeof item !== "object" || typeof item.source !== "string" || !item.source.trim()) throw new Error(`${label} requires source`);
    if (!["collected", "not_found", "failed", "not_collected"].includes(item.status)) throw new Error(`${label} has invalid status`);
    if (["failed", "not_collected"].includes(item.status) && (typeof item.reason !== "string" || !item.reason.trim())) throw new Error(`${label} requires reason`);
    if (item.subject !== undefined && (!item.subject || typeof item.subject.kind !== "string" || !item.subject.kind.trim() || typeof item.subject.value !== "string" || !item.subject.value.trim())) throw new Error(`${label} has invalid subject`);
    if (item.errorKind !== undefined && (typeof item.errorKind !== "string" || !item.errorKind.trim())) throw new Error(`${label} has invalid errorKind`);
    if (item.errorCode !== undefined && typeof item.errorCode !== "string" && (typeof item.errorCode !== "number" || !Number.isFinite(item.errorCode))) throw new Error(`${label} has invalid errorCode`);
    if (item.observedAt !== undefined && (typeof item.observedAt !== "string" || !Number.isFinite(Date.parse(item.observedAt)))) throw new Error(`${label} has invalid observedAt`);
    return {
      ...(item.observedAt !== undefined ? { observedAt: item.observedAt } : {}),
      source: item.source, status: item.status,
      ...(item.subject ? { subject: { kind: item.subject.kind, value: item.subject.value } } : {}),
      ...(["failed", "not_collected"].includes(item.status) ? { reason: item.reason } : {}),
      ...(item.status === "failed" && item.errorKind !== undefined ? { errorKind: item.errorKind } : {}),
      ...(item.status === "failed" && item.errorCode !== undefined ? { errorCode: item.errorCode } : {}),
    } as ServiceInspectSource;
  });
}

/** Source metadata consumes the same entry and byte budget as Facts. */
export function boundInspectSources(sources: readonly ServiceInspectSource[], budget: ServiceInspectBudget) {
  const retained: ServiceInspectSource[] = [];
  let bytes = 0;
  for (const source of sources) {
    const size = Buffer.byteLength(JSON.stringify(source), "utf8");
    if (retained.length >= budget.maxFacts || bytes + size > budget.maxBytes) continue;
    retained.push(source);
    bytes += size;
  }
  return { sources: retained, bytes, omitted: sources.length - retained.length };
}
