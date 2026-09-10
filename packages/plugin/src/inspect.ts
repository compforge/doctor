import type { PluginContext } from "./context";
import type { ServiceInspectQuery, ServiceInspectQueryHandler, ServiceInspectResult } from "./service";

/** Adapt a single-query provider without hiding parallel requests or aborting healthy siblings. */
export function inspectIndividually(
  inspect: (context: PluginContext, query: ServiceInspectQuery) => Promise<ServiceInspectResult>,
): ServiceInspectQueryHandler {
  return async (context, queries) => {
    const outcomes = [];
    for (const query of queries) {
      context.signal?.throwIfAborted();
      try {
        outcomes.push({ identity: query.identity, status: "collected" as const, result: await inspect(context, query) });
      } catch (error) {
        outcomes.push({ identity: query.identity, status: "failed" as const,
          reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcomes;
  };
}
