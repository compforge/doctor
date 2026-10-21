import { workerDatabase } from "./database";
import { articleToMarkdown, conceptToMarkdown, knowledgeToMarkdown, sectionToMarkdown, stepToMarkdown, workflowToMarkdown } from "@compforge/doctor-plugin";
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
    cases: [apiCases],
    logs: { default: true }
  },
  {
    name: "example-worker",
    upstream: ["example-api"],
    knowledge: { markdown() { return knowledgeToMarkdown(this); }, concepts: [{ markdown() { return conceptToMarkdown(this); }, id: "queue", name: "Queue", description: "The worker executes queued jobs." }] },
    extensions: [workerHealthCases],
    component: { name: "example-worker", repository: { forge: { name: "github" }, path: "compforge/doctor" } },
    workloads: [kubernetesServiceWorkload("example-worker")],
    toolchain: {
      language: "python",
      executionPlatform: "python",
      dependencyManager: "uv",
    },
    logs: { default: false },
    dataSources: [workerDatabase]
  },
] as const);

export const examplePlugin = {
  id: "example",
  version: pluginPackage.version,
  services,
  knowledge: {
    markdown() { return knowledgeToMarkdown(this); },
    concepts: [{ markdown() { return conceptToMarkdown(this); }, id: "job", name: "Job", description: "A Job has a request and an execution result." }],
    workflows: [{ markdown() { return workflowToMarkdown(this); }, id: "execution", title: "Job execution", summary: "The API queues work for the worker.",
      steps: [{ markdown() { return stepToMarkdown(this); }, id: "accept", title: "Accept", description: "Validate and queue the request." },
        { markdown() { return stepToMarkdown(this); }, id: "execute", title: "Execute", description: "Execute the queued job." },
        { markdown() { return stepToMarkdown(this); }, id: "persist", parentId: "execute", title: "Persist", description: "Save the execution result." }] }],
    articles: [{ markdown() { return articleToMarkdown(this); }, id: "queue-capacity", title: "Queue capacity", summary: "Understand a full queue.",
      sections: [{ markdown() { return sectionToMarkdown(this); }, id: "investigate", title: "Investigate", body: "Check queue depth and worker throughput using current evidence." }] }],
    dictionaries: [exampleErrors],
  },
} satisfies PluginDefinition;

export default examplePlugin;
