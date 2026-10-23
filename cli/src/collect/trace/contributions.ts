import type { TraceContributions } from "@compforge/trace-harness";

/** @spec Online acquisition and local imports use the same Plugin-owned projections and generic defaults. */
export async function traceContributions(plugin?: TraceContributions): Promise<TraceContributions> {
  const { genAiSpecs, mergeTraceContributions } = await import("@compforge/trace-harness");
  const specs = [...(plugin?.specs ?? [])];
  const overriddenKinds = new Set(specs.map(spec => spec.kind));
  // A kind has one projection owner; generic specs must not shadow Plugin facts.
  return mergeTraceContributions(
    { ...plugin, specs },
    { specs: [...genAiSpecs()].filter(spec => !overriddenKinds.has(spec.kind)) },
  );
}
