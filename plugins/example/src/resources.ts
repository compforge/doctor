import { withSummary, type ServiceResourceDefinition } from "@compforge/doctor-plugin";

const resource = { id: "example.worker-volumes", kind: "volume", name: "Worker volumes",
  description: "Persistent volumes claimed by example-worker in the selected namespace." };

/** The Service owns label semantics; Core owns selection, budgets and reporting. */
export const workerVolumes: ServiceResourceDefinition = {
  resource, relationship: "uses",
  observe: {
    access: { kubernetes: [{ rule: { verb: "list", resource: "persistentvolumeclaims" },
      requirement: "preferred", purpose: "Read worker volume claims", fallback: "Report permission_denied" }] },
    run: withSummary({ title: "Worker volumes", fields: [{ label: "Coverage", path: ["coverage", "status"] }] }, async (context, query) => {
      const result = await context.infra.kubernetes.list<{
        metadata: { uid: string; name: string }; status?: { phase?: string };
      }>({ apiVersion: "v1", resource: "persistentvolumeclaims", labelSelector: "app=example-worker",
        limit: query.maxInstances, continue: query.cursor });
      const nextCursor = result.metadata?.continue || undefined;
      return { resource, environment: context.target.env, observedAt: new Date().toISOString(),
        source: "kubernetes/persistentvolumeclaims", scope: { namespace: context.target.namespace, labelSelector: "app=example-worker" },
        coverage: nextCursor ? { status: "partial", reason: "More volume claims are available" } : { status: "complete" },
        // No independent total is available; a page length must not become totalCount.
        instances: result.items.map(item => ({ ref: { environment: context.target.env, resource: resource.id, id: item.metadata.uid },
          name: item.metadata.name, state: item.status?.phase })), nextCursor };
    }),
  },
};
