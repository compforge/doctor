import type { Value } from "@compforge/harness-common";

/** Execution belongs to the Probe; the Value codec only describes the acquired data. */
export type ProbeResult<T extends Value = Value> = { readonly value: T } & (
  | { readonly status: "ok" }
  | { readonly status: "partial" | "unavailable"; readonly reason: string }
);

export function validateProbeResult(result: ProbeResult): void {
  if (!result || !["ok", "partial", "unavailable"].includes(result.status)
    || !result.value || typeof result.value.summary !== "function"
    || (result.status !== "ok" && (typeof result.reason !== "string" || !result.reason.trim()))) {
    throw new Error("Probe requires a Value and an execution status; incomplete results require a reason");
  }
}

