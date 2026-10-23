import { createServiceCatalog, withSummary } from "@compforge/doctor-plugin";
import { startDoctor } from "doctor-cli/embed";

const resource = { id: "worker-volumes", kind: "volume", name: "Worker volumes" };
startDoctor({ name: "resource-fixture", commands: "resource", optionDefaults: { config: "" },
  plugin: { id: "resource-fixture", version: "1.0.0", services: createServiceCatalog([{
    name: "worker", aliases: ["w"], workloads: [], component: { name: "worker", repository: { forge: { name: "test" }, path: "worker" } },
    resources: [{ resource, relationship: "uses", observe: { access: {}, run: withSummary({ title: "Worker volumes", fields: [] }, async context => ({
      resource, environment: context.target.env, observedAt: "2026-10-23T00:00:00Z", source: "fixture", scope: {},
      coverage: { status: "complete" }, totalCount: 0, instances: [],
    })) } }],
  }]) },
});
