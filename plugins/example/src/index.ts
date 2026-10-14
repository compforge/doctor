import {
  createServiceCatalog,
  kubernetesServiceWorkload,
  type PluginDefinition,
} from "@compforge/doctor-plugin";
import pluginPackage from "../package.json" with { type: "json" };
import { exampleErrors } from "./errors";
import { apiCases, workerHealthCases } from "./cases";

const services = createServiceCatalog([
  {
    name: "example-api",
    upstream: [],
    component: { name: "example-api", repository: { forge: { name: "github" }, path: "compforge/doctor" } },
    workloads: [kubernetesServiceWorkload("example-api")],
    toolchain: {
      language: "typescript",
      executionPlatform: "node",
      dependencyManager: "npm",
      buildTool: "tsc",
    },
    configurationInspection: true,
    cases: [apiCases],
    logs: { default: true }
  },
  {
    name: "example-worker",
    upstream: ["example-api"],
    knowledge: { concepts: [{ id: "queue", name: "Queue", description: "The worker executes queued jobs." }] },
    extensions: [workerHealthCases],
    component: { name: "example-worker", repository: { forge: { name: "github" }, path: "compforge/doctor" } },
    workloads: [kubernetesServiceWorkload("example-worker")],
    toolchain: {
      language: "python",
      executionPlatform: "python",
      dependencyManager: "uv",
    },
    logs: { default: false },
    dataSources: [{
      id: "primary-database",
      kind: "db",
      backend: "mysql",
      envPrefix: "DATABASE_",
    }]
  },
] as const);

export const examplePlugin = {
  id: "example",
  version: pluginPackage.version,
  services,
  knowledge: {
    concepts: [{ id: "job", name: "Job", description: "A Job has a request and an execution result." }],
    workflows: [{ id: "execution", title: "Job execution", summary: "The API queues work for the worker.",
      steps: [{ id: "accept", title: "Accept", description: "Validate and queue the request." },
        { id: "execute", title: "Execute", description: "Execute the queued job." },
        { id: "persist", parentId: "execute", title: "Persist", description: "Save the execution result." }] }],
    articles: [{ id: "queue-capacity", title: "Queue capacity", summary: "Understand a full queue.",
      sections: [{ id: "investigate", title: "Investigate", body: "Check queue depth and worker throughput using current evidence." }] }],
    dictionaries: [exampleErrors],
  },
} satisfies PluginDefinition;

export default examplePlugin;
